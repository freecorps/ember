/**
 * In-process fake Ember server speaking WS protocol v1 (same semantics as `packages/runtime/src/shard.ts`):
 * hello/ready, sub/snap (with resume -> `unchanged`), patch per version, mut/mres with dedup by
 * (identity, clientId, mid), auth re-snap, authExpired, "ping"/"pong". Reactivity is per table: a query re-runs when
 * a mutation writes a table it read. For tests of client SDKs; not a database.
 */
import type { ClientMessage, Id, ServerMessage } from "./protocol.ts";
import { parse, stableStringify, stringify } from "./wire.ts";
import type { WebSocketLike } from "./client.ts";

export interface FakeIdentity {
  subject: string;
  /** seconds since epoch */
  exp?: number;
}

export interface FakeCtx {
  identity: FakeIdentity | null;
  shard: string;
}

export interface FakeDb {
  /** Rows of a table (records the read). */
  all<T = Record<string, unknown>>(table: string): T[];
  /** Rows with `row[field] === value`; only writes touching such rows invalidate the read (an index range). */
  where<T = Record<string, unknown>>(table: string, field: string, value: unknown): T[];
  insert(table: string, row: Record<string, unknown>): string;
  patch(table: string, id: string, fields: Record<string, unknown>): void;
  delete(table: string, id: string): void;
}

export type FakeQuery = (db: FakeDb, args: any, ctx: FakeCtx) => unknown;
export type FakeMutation = (db: FakeDb, args: any, ctx: FakeCtx) => unknown;

/** Throw from a fake function to produce `{code, message}`. */
export class FakeFunctionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface FakeServerOptions {
  queries?: Record<string, FakeQuery>;
  mutations?: Record<string, FakeMutation>;
  /** token -> identity (null = invalid). Default: token "user:<subject>" or "user:<subject>:<exp>". */
  verify?: (token: string) => FakeIdentity | null;
  /** Strict decoder for client frames (e.g. the runtime's `decodeClientMessage`); throws on bad frames. */
  decodeClientMessage?: (raw: string) => ClientMessage;
  /** Change-log length kept for resume. Default 256. */
  changeLogVersions?: number;
  now?: () => number;
}

interface ShardState {
  name: string;
  version: number;
  epoch: string;
  tables: Map<string, Map<string, Record<string, unknown>>>;
  changelog: Array<{ version: number; tables: Set<string> }>;
  dedup: Map<string, Extract<ServerMessage, { t: "mres" }>>;
  nextId: number;
}

interface SubState {
  qid: Id;
  fn: string;
  args: Record<string, unknown>;
  json: string;
  reads: Set<string>;
}

let socketSeq = 0;

export class FakeSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  readonly id = ++socketSeq;
  readonly shard: string;
  identity: FakeIdentity | null = null;
  clientId: string | null = null;
  hello = false;
  readonly subs = new Map<string, SubState>();
  /** Every frame the client sent, decoded (strings for "ping"). */
  readonly sent: Array<ClientMessage | "ping"> = [];
  /** Every frame the server sent. */
  readonly received: Array<ServerMessage | "pong"> = [];
  /** When set, outgoing server frames are queued instead of delivered. */
  held: string[] | null = null;
  /** When true, "ping" gets no "pong" (half-open socket). */
  silent = false;

  constructor(
    readonly url: string,
    private readonly server: FakeEmberServer,
  ) {
    this.shard = decodeURIComponent(new URL(url).searchParams.get("shard") ?? "");
    server.attach(this);
  }

  /** When set, client frames are queued before the server sees them. */
  heldIncoming: string[] | null = null;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    if (this.heldIncoming) {
      this.heldIncoming.push(data);
      return;
    }
    queueMicrotask(() => this.server.receive(this, data));
  }

  holdIncoming(): void {
    this.heldIncoming ??= [];
  }

  releaseIncoming(): void {
    const q = this.heldIncoming ?? [];
    this.heldIncoming = null;
    for (const d of q) queueMicrotask(() => this.server.receive(this, d));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server.detach(this);
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /** Server-side close (network drop, eviction). */
  drop(code = 1006): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server.detach(this);
    queueMicrotask(() => this.onclose?.({ code, reason: "dropped" }));
  }

  /** @internal */
  deliver(frame: string): void {
    if (this.readyState !== 1) return;
    if (this.held) {
      this.held.push(frame);
      return;
    }
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: frame });
    });
  }

  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const q = this.held ?? [];
    this.held = null;
    for (const f of q) this.deliver(f);
  }
}

export class FakeEmberServer {
  readonly queries: Record<string, FakeQuery>;
  readonly mutations: Record<string, FakeMutation>;
  readonly sockets = new Set<FakeSocket>();
  /** Every socket ever opened, in order. */
  readonly history: FakeSocket[] = [];
  /** Connections to refuse (closed right after open with 1006) before accepting again. */
  refuseConnections = 0;
  /** HTTP requests seen by `fetch`. */
  readonly httpRequests: Array<{ path: string; body: unknown; authorization: string | null }> = [];
  private readonly shards = new Map<string, ShardState>();
  private readonly opts: FakeServerOptions;
  /** Count of mutation executions (dedup hits excluded). */
  executions = 0;

  constructor(opts: FakeServerOptions = {}) {
    this.opts = opts;
    this.queries = { ...opts.queries };
    this.mutations = { ...opts.mutations };
  }

  /** Pass as `new EmberClient({ WebSocket: server.WebSocket })`. */
  get WebSocket(): new (url: string) => FakeSocket {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(url, server);
      }
    };
  }

  /** Pass as `new EmberClient({ fetch: server.fetch })`: serves `POST /api/query` and `/api/mutation`. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = parse(String(init?.body ?? "{}")) as { fn: string; args: Record<string, unknown>; shard: string };
    const authorization = headers.get("authorization");
    this.httpRequests.push({ path: url.pathname, body, authorization });
    const json = (b: unknown, status = 200) => new Response(stringify(b), { status, headers: { "content-type": "application/json" } });
    let identity: FakeIdentity | null = null;
    if (authorization?.startsWith("Bearer ")) {
      identity = this.verify(authorization.slice(7));
      if (!identity) return json({ ok: false, error: { code: "unauthenticated", message: "invalid token" } }, 401);
    }
    const shard = this.shard(body.shard);
    if (url.pathname === "/api/query") {
      try {
        const { value } = this.runQuery(shard, body.fn, body.args ?? {}, identity);
        return json({ ok: true, value, version: shard.version });
      } catch (e) {
        return json({ ok: false, error: errInfo(e, "query_failed") }, 400);
      }
    }
    if (url.pathname === "/api/mutation") {
      const out = this.runMutation(shard, body.fn, body.args ?? {}, identity);
      return json(out, out.ok ? 200 : 400);
    }
    return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
  }) as typeof fetch;

  // ---------------------------------------------------------------------------------------------- inspection

  shard(name: string): ShardState {
    let s = this.shards.get(name);
    if (!s) {
      s = { name, version: 0, epoch: `epoch-${Math.random().toString(36).slice(2, 8)}`, tables: new Map(), changelog: [], dedup: new Map(), nextId: 0 };
      this.shards.set(name, s);
    }
    return s;
  }

  version(shard: string): number {
    return this.shard(shard).version;
  }

  rows(shard: string, table: string): Record<string, unknown>[] {
    return [...(this.shard(shard).tables.get(table)?.values() ?? [])];
  }

  /** Open sockets of a shard. */
  open(shard?: string): FakeSocket[] {
    return [...this.sockets].filter((s) => s.readyState === 1 && (shard === undefined || s.shard === shard));
  }

  /** Total active server subscriptions. */
  subscriptionCount(shard?: string): number {
    return this.open(shard).reduce((n, s) => n + s.subs.size, 0);
  }

  /** Simulate the epoch changing (shard restored from backup): resumes are rejected. */
  resetEpoch(shard: string): void {
    this.shard(shard).epoch = `epoch-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Drop every open socket (optionally of one shard). */
  dropAll(shard?: string): void {
    for (const s of this.open(shard)) s.drop();
  }

  /** Send `authExpired` and clear identity, as the runtime does when the JWT `exp` passed. */
  expireAuth(shard?: string): void {
    for (const s of this.open(shard)) {
      s.identity = null;
      this.send(s, { t: "authExpired" });
    }
  }

  /** Run a mutation as another client would (HTTP path, no dedup). */
  mutateDirect(shard: string, fn: string, args: Record<string, unknown> = {}, identity: FakeIdentity | null = null) {
    return this.runMutation(this.shard(shard), fn, args, identity);
  }

  // ---------------------------------------------------------------------------------------------- socket plumbing

  /** @internal */
  attach(ws: FakeSocket): void {
    this.history.push(ws);
    if (this.refuseConnections > 0) {
      this.refuseConnections--;
      queueMicrotask(() => {
        ws.readyState = 3;
        ws.onerror?.({});
        ws.onclose?.({ code: 1006, reason: "refused" });
      });
      return;
    }
    this.sockets.add(ws);
    this.shard(ws.shard);
    queueMicrotask(() => {
      if (ws.readyState !== 0) return;
      ws.readyState = 1;
      ws.onopen?.({});
    });
  }

  /** @internal */
  detach(ws: FakeSocket): void {
    this.sockets.delete(ws);
    ws.subs.clear();
  }

  private send(ws: FakeSocket, m: ServerMessage | "pong"): void {
    ws.received.push(m);
    ws.deliver(m === "pong" ? "pong" : stringify(m));
  }

  private verify(token: string): FakeIdentity | null {
    if (this.opts.verify) return this.opts.verify(token);
    const m = /^user:([^:]+)(?::(\d+))?$/.exec(token);
    if (!m) return null;
    return m[2] ? { subject: m[1]!, exp: Number(m[2]) } : { subject: m[1]! };
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** @internal */
  receive(ws: FakeSocket, raw: string): void {
    if (ws.readyState !== 1) return;
    if (raw === "ping") {
      ws.sent.push("ping");
      if (!ws.silent) this.send(ws, "pong");
      return;
    }
    let msg: ClientMessage;
    try {
      msg = this.opts.decodeClientMessage ? this.opts.decodeClientMessage(raw) : strictDecode(raw);
    } catch (e) {
      ws.sent.push(raw as never);
      this.send(ws, { t: "err", code: (e as { code?: string }).code ?? "bad_frame", message: (e as Error).message });
      return;
    }
    ws.sent.push(msg);
    const shard = this.shard(ws.shard);
    if (msg.t !== "hello" && !ws.hello) {
      this.send(ws, { t: "err", code: "no_hello", message: "send hello first" });
      return;
    }
    if (ws.identity?.exp !== undefined && ws.identity.exp * 1000 <= this.now() && msg.t !== "auth") {
      ws.identity = null;
      this.send(ws, { t: "authExpired" });
    }
    switch (msg.t) {
      case "hello": {
        if (ws.hello) return this.send(ws, { t: "err", code: "duplicate_hello", message: "hello already received" });
        if (msg.token !== undefined) {
          const id = this.verify(msg.token);
          if (!id) this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
          else ws.identity = id;
        }
        ws.clientId = msg.clientId;
        ws.hello = true;
        return this.send(ws, { t: "ready", shard: shard.name, version: shard.version, epoch: shard.epoch });
      }
      case "sub": {
        const k = JSON.stringify(msg.qid);
        if (ws.subs.has(k)) return this.send(ws, { t: "err", code: "duplicate_qid", message: "qid already subscribed", qid: msg.qid });
        let r: { value: unknown; reads: Set<string> };
        try {
          r = this.runQuery(shard, msg.fn, msg.args, ws.identity);
        } catch (e) {
          const err = errInfo(e, "query_failed");
          return this.send(ws, { t: "err", code: err.code, message: err.message, qid: msg.qid });
        }
        ws.subs.set(k, { qid: msg.qid, fn: msg.fn, args: msg.args, json: stringify(r.value), reads: r.reads });
        if (msg.resume && this.resumeUnchanged(shard, msg.resume, r.reads)) {
          return this.send(ws, { t: "snap", qid: msg.qid, version: shard.version, unchanged: true });
        }
        return this.send(ws, { t: "snap", qid: msg.qid, version: shard.version, value: r.value });
      }
      case "unsub":
        ws.subs.delete(JSON.stringify(msg.qid));
        return;
      case "mut": {
        const key = `${ws.identity?.subject ?? "anon"}\n${ws.clientId ?? ""}\n${JSON.stringify(msg.mid)}`;
        const hit = shard.dedup.get(key);
        if (hit) return this.send(ws, { ...hit, mid: msg.mid });
        const out = this.runMutation(shard, msg.fn, msg.args, ws.identity);
        const mres: Extract<ServerMessage, { t: "mres" }> = out.ok
          ? { t: "mres", mid: msg.mid, ok: true, value: out.value, version: out.version }
          : { t: "mres", mid: msg.mid, ok: false, error: out.error };
        shard.dedup.set(key, mres);
        return this.send(ws, mres);
      }
      case "auth": {
        const id = this.verify(msg.token);
        if (!id) return this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
        ws.identity = id;
        for (const [k, sub] of [...ws.subs]) {
          try {
            const r = this.runQuery(shard, sub.fn, sub.args, id);
            sub.json = stringify(r.value);
            sub.reads = r.reads;
            this.send(ws, { t: "snap", qid: sub.qid, version: shard.version, value: r.value });
          } catch (e) {
            ws.subs.delete(k);
            const err = errInfo(e, "query_failed");
            this.send(ws, { t: "err", code: err.code, message: err.message, qid: sub.qid });
          }
        }
        return;
      }
    }
  }

  private resumeUnchanged(shard: ShardState, resume: { version: number; epoch: string }, reads: Set<string>): boolean {
    if (resume.epoch !== shard.epoch || resume.version > shard.version) return false;
    if (resume.version === shard.version) return true;
    const since = shard.changelog.filter((c) => c.version > resume.version);
    if (since.length !== shard.version - resume.version) return false;
    return !since.some((c) => [...c.tables].some((t) => reads.has(t)));
  }

  // ---------------------------------------------------------------------------------------------- execution

  private db(shard: ShardState, reads: Set<string>, writes: Set<string> | null): FakeDb {
    const table = (t: string) => {
      let m = shard.tables.get(t);
      if (!m) shard.tables.set(t, (m = new Map()));
      return m;
    };
    const ro = () => {
      throw new FakeFunctionError("read_only", "queries cannot write");
    };
    return {
      all: (t) => {
        reads.add(t);
        return [...table(t).values()].map((r) => ({ ...r })) as any;
      },
      where: (t, f, v) => {
        reads.add(`${t}#${f}=${stableStringify(v)}`);
        return [...table(t).values()].filter((r) => stableStringify(r[f]) === stableStringify(v)).map((r) => ({ ...r })) as any;
      },
      insert: (t, row) => {
        if (!writes) return ro();
        const id = `${t}_${++shard.nextId}`;
        table(t).set(id, { _id: id, ...row });
        touch(writes, t, table(t).get(id));
        return id;
      },
      patch: (t, id, fields) => {
        if (!writes) return ro();
        const cur = table(t).get(id);
        if (!cur) throw new FakeFunctionError("not_found", `${t} ${id} not found`);
        table(t).set(id, { ...cur, ...fields });
        touch(writes, t, cur);
        touch(writes, t, table(t).get(id));
      },
      delete: (t, id) => {
        if (!writes) return ro();
        const cur = table(t).get(id);
        if (table(t).delete(id)) touch(writes, t, cur);
      },
    };
  }

  private runQuery(shard: ShardState, fn: string, args: Record<string, unknown>, identity: FakeIdentity | null) {
    const q = this.queries[fn];
    if (!q) throw new FakeFunctionError("function_not_found", `query ${fn} not found`);
    const reads = new Set<string>();
    const value = q(this.db(shard, reads, null), args, { identity, shard: shard.name });
    return { value: value === undefined ? null : value, reads };
  }

  private runMutation(
    shard: ShardState,
    fn: string,
    args: Record<string, unknown>,
    identity: FakeIdentity | null,
  ): { ok: true; value: unknown; version: number } | { ok: false; error: { code: string; message: string } } {
    const m = this.mutations[fn];
    if (!m) return { ok: false, error: { code: "function_not_found", message: `mutation ${fn} not found` } };
    this.executions++;
    const snapshot = new Map([...shard.tables].map(([k, v]) => [k, new Map(v)]));
    const writes = new Set<string>();
    let value: unknown;
    try {
      value = m(this.db(shard, new Set(), writes), args, { identity, shard: shard.name });
    } catch (e) {
      shard.tables = snapshot;
      return { ok: false, error: errInfo(e, "mutation_failed") };
    }
    if (writes.size) {
      shard.version++;
      shard.changelog.push({ version: shard.version, tables: writes });
      const keep = this.opts.changeLogVersions ?? 256;
      while (shard.changelog.length > keep) shard.changelog.shift();
      this.publish(shard, writes);
    }
    return { ok: true, value: value === undefined ? null : value, version: shard.version };
  }

  private publish(shard: ShardState, writes: Set<string>): void {
    for (const ws of this.open(shard.name)) {
      const changes: Array<{ qid: Id; value: unknown }> = [];
      for (const [k, sub] of [...ws.subs]) {
        if (![...sub.reads].some((t) => writes.has(t))) continue;
        try {
          const r = this.runQuery(shard, sub.fn, sub.args, ws.identity);
          sub.reads = r.reads;
          const json = stringify(r.value);
          if (json === sub.json) continue;
          sub.json = json;
          changes.push({ qid: sub.qid, value: r.value });
        } catch (e) {
          const err = errInfo(e, "query_failed");
          sub.json = `\u0000error`;
          void k;
          this.send(ws, { t: "err", code: err.code, message: err.message, qid: sub.qid });
        }
      }
      if (changes.length) this.send(ws, { t: "patch", version: shard.version, changes });
    }
  }
}

/** A write touches the table (full scans) and every `field=value` of the row (`where` reads). */
function touch(writes: Set<string>, t: string, row: Record<string, unknown> | undefined): void {
  writes.add(t);
  if (row) for (const [f, v] of Object.entries(row)) writes.add(`${t}#${f}=${stableStringify(v)}`);
}

function errInfo(e: unknown, fallback: string): { code: string; message: string } {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : fallback;
  return { code, message: e instanceof Error ? e.message : String(e) };
}

/** Same acceptance rules as the runtime decoder (keys, types), compact. */
function strictDecode(raw: string): ClientMessage {
  const bad = (m: string): never => {
    throw Object.assign(new Error(m), { code: "bad_frame" });
  };
  const m = parse(raw) as Record<string, unknown>;
  if (!m || typeof m !== "object" || Array.isArray(m)) bad("frame must be an object");
  const allowed: Record<string, [string[], string[]]> = {
    hello: [["t", "clientId", "protocol"], ["token"]],
    sub: [["t", "qid", "fn", "args"], ["resume"]],
    unsub: [["t", "qid"], []],
    mut: [["t", "mid", "fn", "args"], []],
    auth: [["t", "token"], []],
  };
  const spec = allowed[m.t as string] ?? bad(`unknown frame type ${JSON.stringify(m.t)}`);
  for (const k of spec[0]) if (!(k in m)) bad(`missing field "${k}"`);
  for (const k of Object.keys(m)) if (!spec[0].includes(k) && !spec[1].includes(k)) bad(`unknown field "${k}"`);
  if (m.t === "hello" && m.protocol !== 1) bad("protocol must be 1");
  if ("args" in m && (!m.args || typeof m.args !== "object" || Array.isArray(m.args))) bad(`"args" must be an object`);
  return m as unknown as ClientMessage;
}

export { stableStringify };
