/**
 * Minimal stand-in for the `@ember/server` Engine, implemented over SqlDriver.
 * Documents live in one table; read-sets are id ranges per table, encoded as UTF-8 bytes.
 */
import type {
  AuthCtx,
  CreateEngine,
  Doc,
  Engine,
  Job,
  MutationResult,
  ReadSet,
  RowChange,
  SqlDriver,
} from "../src/engine-types.ts";

export interface FakeDb {
  get(table: string, id: string): Doc | null;
  list(table: string): Doc[];
  insert(table: string, doc: Doc): string;
  patch(table: string, id: string, fields: Doc): void;
  delete(table: string, id: string): void;
}

export interface FakeCtx {
  db: FakeDb;
  auth: AuthCtx;
  now: number;
  scheduler: { runAfter(ms: number, fn: string, args?: unknown): void; runAt(at: number, fn: string, args?: unknown): void };
}

export type FakeFunctions = Record<string, { kind: "query" | "mutation" | "action"; handler: (ctx: FakeCtx, args: any) => unknown }>;

export const engineCounters = { migrate: 0, created: 0 };

const enc = new TextEncoder();
const HI = new Uint8Array([0xff]);

function cmp(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const createFakeEngine: CreateEngine = ({ functions, driver, now = Date.now }) => {
  engineCounters.created++;
  const fns = functions as FakeFunctions;

  const makeCtx = (auth: AuthCtx, readSet: ReadSet, changes: RowChange[] | null, scheduled: Job[]): FakeCtx => {
    const t = now();
    const load = (table: string, id: string): Doc | null => {
      const r = driver.exec("SELECT doc FROM fake_docs WHERE tbl = ? AND id = ?", table, id).rows[0];
      return r ? (JSON.parse(r.doc as string) as Doc) : null;
    };
    const write = () => {
      if (!changes) throw new CodedError("read_only", "queries cannot write");
      return changes;
    };
    const sched = (at: number, fn: string, args?: unknown) => {
      const kind = fns[fn]?.kind === "action" ? "action" : "mutation";
      scheduled.push({ fn, args: args ?? {}, runAt: at, kind });
    };
    return {
      auth,
      now: t,
      scheduler: { runAfter: (ms, fn, args) => sched(t + ms, fn, args), runAt: sched },
      db: {
        get(table, id) {
          const k = enc.encode(id);
          readSet.push({ table, index: "by_id", lo: k, hi: new Uint8Array([...k, 0]), kind: "db" });
          return load(table, id);
        },
        list(table) {
          readSet.push({ table, index: "by_id", lo: new Uint8Array(), hi: HI, kind: "db" });
          return driver
            .exec("SELECT doc FROM fake_docs WHERE tbl = ? ORDER BY seq", table)
            .rows.map((r) => JSON.parse(r.doc as string) as Doc);
        },
        insert(table, doc) {
          const id = crypto.randomUUID();
          const full = { ...doc, _id: id };
          driver.exec("INSERT INTO fake_docs(tbl, id, doc) VALUES (?, ?, ?)", table, id, JSON.stringify(full));
          write().push({ table, id, before: null, after: full });
          return id;
        },
        patch(table, id, fields) {
          const before = load(table, id);
          if (!before) throw new CodedError("not_found", `${table}/${id} not found`);
          const after = { ...before, ...fields };
          driver.exec("UPDATE fake_docs SET doc = ? WHERE tbl = ? AND id = ?", JSON.stringify(after), table, id);
          write().push({ table, id, before, after });
        },
        delete(table, id) {
          const before = load(table, id);
          if (!before) return;
          driver.exec("DELETE FROM fake_docs WHERE tbl = ? AND id = ?", table, id);
          write().push({ table, id, before, after: null });
        },
      },
    };
  };

  const fn = (name: string, kind: "query" | "mutation") => {
    const f = fns[name];
    if (!f || f.kind !== kind) throw new CodedError("unknown_function", `no ${kind} named ${name}`);
    return f;
  };

  const runMutation = (name: string, args: unknown, auth: AuthCtx) => {
    const f = fn(name, "mutation");
    const changes: RowChange[] = [];
    const scheduled: Job[] = [];
    const value = driver.transaction(() => f.handler(makeCtx(auth, [], changes, scheduled), args));
    return { value, changes, scheduled };
  };

  const engine: Engine = {
    migrate() {
      engineCounters.migrate++;
      driver.exec(
        "CREATE TABLE IF NOT EXISTS fake_docs (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, UNIQUE (tbl, id))",
      );
      return { changed: true };
    },
    runQuery(name, args, auth) {
      const f = fn(name, "query");
      const readSet: ReadSet = [];
      const value = f.handler(makeCtx(auth, readSet, null, []), args);
      return { value, readSet };
    },
    runMutation,
    runMutationBatch(items) {
      return driver.transaction(() =>
        items.map((it): MutationResult => {
          try {
            return { ok: true, ...runMutation(it.name, it.args, it.ctx) };
          } catch (e) {
            const code = e instanceof CodedError ? e.code : "mutation_failed";
            return { ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } };
          }
        }),
      );
    },
    matches(readSet, changes) {
      for (const c of changes) {
        const k = enc.encode(c.id);
        for (const r of readSet) {
          if (r.table === c.table && cmp(k, r.lo) >= 0 && cmp(k, r.hi) < 0) return true;
        }
      }
      return false;
    },
  };
  return engine;
};
