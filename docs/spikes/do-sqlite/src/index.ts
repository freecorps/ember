import { DurableObject } from "cloudflare:workers";

export interface Env {
  SPIKE: DurableObjectNamespace<SpikeDO>;
}

type AlarmLog = { attempt: number; retryCount: number; isRetry: boolean; at: number };

/**
 * One SQLite-backed Durable Object used by every spike test.
 * Most SQL checks are driven from tests via runInDurableObject(); this class
 * holds the pieces that need real DO entrypoints: alarm(), fetch() upgrade,
 * and the hibernation handlers.
 */
export class SpikeDO extends DurableObject<Env> {
  sql: SqlStorage;
  /** in-memory log, survives across alarm retries only if the isolate is not evicted */
  memLog: any[] = [];

  static constructed = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    SpikeDO.constructed++;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, run_at INTEGER NOT NULL, payload TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_run_at ON jobs(run_at);
      CREATE TABLE IF NOT EXISTS job_runs (
        id INTEGER PRIMARY KEY, job_id INTEGER, name TEXT, run_at INTEGER, ran_at INTEGER, alarm_retry INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS alarm_log (
        id INTEGER PRIMARY KEY, attempt INTEGER, retry_count INTEGER, is_retry INTEGER, at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ws_msgs (id INTEGER PRIMARY KEY, msg TEXT, at INTEGER) STRICT;
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------------------------------------------------------------- meta
  private getMeta(k: string): string | null {
    const r = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray();
    return r.length ? r[0].v : null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  // ---------------------------------------------------------------- scheduler
  /** Multiplexed scheduler: many jobs, one alarm = min(run_at). */
  async schedule(name: string, delayMs: number, payload: unknown = null): Promise<number> {
    this.setMeta("alarm_mode", "scheduler");
    const runAt = Date.now() + delayMs;
    const { id } = this.sql
      .exec<{ id: number }>(
        "INSERT INTO jobs(name, run_at, payload) VALUES (?, ?, ?) RETURNING id",
        name, runAt, JSON.stringify(payload),
      )
      .one();
    await this.armAlarm();
    return id;
  }

  private async armAlarm() {
    const { m } = this.sql.exec<{ m: number | null }>("SELECT MIN(run_at) AS m FROM jobs").one();
    if (m == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur !== m) await this.ctx.storage.setAlarm(m);
  }

  async schedulerState() {
    return {
      jobs: this.sql.exec("SELECT * FROM jobs ORDER BY run_at").toArray(),
      runs: this.sql.exec("SELECT * FROM job_runs ORDER BY id").toArray(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  // ---------------------------------------------------------------- alarm retry test
  async configureRetryTest(failTimes: number, delayMs: number) {
    this.setMeta("alarm_mode", "retry");
    this.setMeta("fail_times", String(failTimes));
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }
  async alarmLog(): Promise<AlarmLog[]> {
    return this.sql
      .exec<any>("SELECT attempt, retry_count AS retryCount, is_retry AS isRetry, at FROM alarm_log ORDER BY id")
      .toArray();
  }

  async alarm(alarmInfo?: AlarmInvocationInfo) {
    const mode = this.getMeta("alarm_mode");
    const now = Date.now();
    this.memLog.push({ at: now, retryCount: alarmInfo?.retryCount, isRetry: alarmInfo?.isRetry, getAlarmInsideHandler: await this.ctx.storage.getAlarm() });
    if (mode === "retry") {
      const { n } = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM alarm_log").one();
      // Is this write kept when the handler throws? (test compares with memLog)
      this.sql.exec(
        "INSERT INTO alarm_log(attempt, retry_count, is_retry, at) VALUES (?, ?, ?, ?)",
        n + 1, alarmInfo?.retryCount ?? -1, alarmInfo?.isRetry ? 1 : 0, now,
      );
      const failTimes = Number(this.getMeta("fail_times") ?? "0");
      // decide on in-memory attempt count so the test terminates even if SQL writes are rolled back on throw
      if (this.memLog.length <= failTimes) throw new Error(`intentional alarm failure #${this.memLog.length}`);
      return;
    }
    if (mode === "scheduler") {
      // Run every due job, then re-arm for the earliest remaining job.
      for (;;) {
        const due = this.sql
          .exec<any>("SELECT * FROM jobs WHERE run_at <= ? ORDER BY run_at LIMIT 100", Date.now())
          .toArray();
        if (!due.length) break;
        for (const job of due) {
          this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id);
          this.sql.exec(
            "INSERT INTO job_runs(job_id, name, run_at, ran_at, alarm_retry) VALUES (?, ?, ?, ?, ?)",
            job.id, job.name, job.run_at, Date.now(), alarmInfo?.retryCount ?? -1,
          );
          if (job.name === "spawner") {
            // schedule a new job *while the alarm handler is executing*
            await this.schedule("spawned-child", 250);
          }
        }
      }
      await this.armAlarm();
    }
  }

  // ---------------------------------------------------------------- websockets
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected ws", { status: 400 });
    const tags = url.searchParams.getAll("tag");
    const pair = new WebSocketPair();
    try {
      this.ctx.acceptWebSocket(pair[1], tags);
    } catch (e: any) {
      return new Response(`acceptWebSocket error: ${e?.message ?? e}`, { status: 400 });
    }
    pair[1].serializeAttachment({ tags, connectedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const m = typeof message === "string" ? message : `<binary ${message.byteLength}>`;
    this.sql.exec("INSERT INTO ws_msgs(msg, at) VALUES (?, ?)", m, Date.now());
    if (m === "whoami") ws.send(JSON.stringify(ws.deserializeAttachment()));
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason); } catch {}
  }

  async wsInfo(tag?: string) {
    return {
      all: this.ctx.getWebSockets().length,
      tagged: tag ? this.ctx.getWebSockets(tag).length : null,
      tagsOfFirst: this.ctx.getWebSockets().length ? this.ctx.getTags(this.ctx.getWebSockets()[0]) : null,
      autoResponse: this.ctx.getWebSocketAutoResponse()
        ? { req: (this.ctx.getWebSocketAutoResponse() as any).request, res: (this.ctx.getWebSocketAutoResponse() as any).response }
        : null,
      autoResponseTs: this.ctx.getWebSockets().map((w) => this.ctx.getWebSocketAutoResponseTimestamp(w)?.getTime() ?? null),
      msgs: this.sql.exec("SELECT msg FROM ws_msgs ORDER BY id").toArray().map((r: any) => r.msg),
    };
  }

  async broadcast(tag: string | null, msg: string) {
    const sockets = tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets();
    const t0 = performance.now();
    for (const ws of sockets) ws.send(msg);
    return { count: sockets.length, innerMs: performance.now() - t0 };
  }

  async attachmentLimits(sizes: number[]) {
    const ws = this.ctx.getWebSockets()[0];
    const out: Record<number, string> = {};
    for (const size of sizes) {
      try {
        ws.serializeAttachment("x".repeat(size));
        const back = ws.deserializeAttachment() as string;
        out[size] = `ok (roundtrip len ${back.length})`;
      } catch (e: any) {
        out[size] = `ERROR: ${e?.message ?? e}`;
      }
    }
    return out;
  }

  async constructedCount() {
    return SpikeDO.constructed;
  }

  async getMemLog() {
    return this.memLog;
  }

  async ping() {
    return Date.now();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("do") ?? "default";
    const stub = env.SPIKE.get(env.SPIKE.idFromName(name));
    if (url.pathname === "/ws") return stub.fetch(request);
    return new Response("do-sqlite spike");
  },
} satisfies ExportedHandler<Env>;
