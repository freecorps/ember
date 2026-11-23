// The agent component on the real engine (node:sqlite) with a small job runner standing in for the runtime's scheduler
// (as in packages/workflows): mutation jobs run in the engine, action jobs run their handler with an ActionCtx that
// resolves references like the runtime does. `live()` is a subscription: it re-runs when a commit touches its read
// set and keeps the size of the patch the protocol would send (vdiff / rowdiff, else the whole value).
import { checkAccess, composeApp, createEngine, resolveReference, splitFunctionName, type Job } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { encodeJson, rowDiff, valueDiff } from "@freecorps/ember-values";

export const T0 = 1_700_000_000_000;

export function harness(def: { schema: any; functions: any; app: any; env?: Record<string, unknown> }) {
  let now = T0;
  const composed = composeApp({ schema: def.schema, functions: def.functions, app: def.app });
  const driver = createNodeSqliteDriver();
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver, now: () => now });
  engine.migrate();
  const fns = new Map(Object.entries(composed.functions));
  let jobs: Job[] = [];
  const subs: Live[] = [];
  const commit = (r: { scheduled: Job[]; cancelled: string[]; changes: any[] }) => {
    jobs.push(...r.scheduled);
    jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
    for (const s of subs) s.onCommit(r.changes);
  };
  const mutate = (name: string, args: unknown) => {
    const r = engine.runMutation(name, args);
    commit(r);
    return r.value;
  };
  const query = (name: string, args: unknown) => engine.runQuery(name, args ?? {}).value;
  const ctxFor = (name: string): any => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => {
      const r = resolveReference(path, ref as any);
      checkAccess(fns as any, r);
      return r.name;
    };
    return {
      runQuery: async (ref: unknown, a?: unknown) => query(res(ref), a ?? {}),
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref), a ?? {}),
      runAction: async (ref: unknown, a?: unknown) => runAction(res(ref), a ?? {}),
      env: def.env ?? {},
      now,
      storage: { getUrl: async (id: string) => `https://files.test/${id}` },
    };
  };
  const runAction = async (name: string, args: unknown) => (fns.get(name) as any).handler(ctxFor(name), args);
  /** Runs due jobs in run_at order until none is due. */
  const tick = async (limit = 200) => {
    for (let i = 0; i < limit; i++) {
      const due = jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return i;
      jobs = jobs.filter((j) => j !== due);
      if (due.kind === "mutation") mutate(due.fn, due.args);
      else await runAction(due.fn, due.args);
    }
    throw new Error("tick: too many jobs");
  };

  class Live {
    value: any;
    readSet: any;
    reruns = 0;
    /** Rows read by the re-runs (engine usage). */
    rowsRead = 0;
    /** Most deltas one re-run returned. */
    maxStreams = 0;
    patches: Array<{ bytes: number; kind: "vdiff" | "diff" | "value"; frame: string }> = [];
    constructor(
      readonly fn: string,
      readonly args: unknown,
    ) {
      const r = engine.runQuery(fn, args);
      this.value = r.value;
      this.readSet = r.readSet;
    }
    onCommit(changes: any[]) {
      if (!changes.length || !engine.matches(this.readSet, changes)) return;
      this.reruns++;
      const r = engine.runQuery(this.fn, this.args);
      this.rowsRead += r.usage?.rowsRead ?? 0;
      this.maxStreams = Math.max(this.maxStreams, (r.value as { streams?: unknown[] })?.streams?.length ?? 0);
      this.readSet = r.readSet;
      const prev = this.value;
      this.value = r.value;
      const whole = encodeJson({ qid: 1, value: r.value });
      const vd = valueDiff(prev, r.value);
      const rd = vd ? null : rowDiff(prev, r.value);
      const change = vd ? encodeJson({ qid: 1, vdiff: vd }) : rd ? encodeJson({ qid: 1, diff: rd }) : whole;
      const kind = vd ? "vdiff" : rd ? "diff" : "value";
      if (change.length >= whole.length) this.patches.push({ bytes: whole.length, kind: "value", frame: whole });
      else this.patches.push({ bytes: change.length, kind, frame: change });
    }
    close() {
      subs.splice(subs.indexOf(this), 1);
    }
  }
  return {
    engine,
    jobs: () => jobs,
    mutate,
    query,
    tick,
    runAction,
    advance: (ms: number) => (now += ms),
    live: (fn: string, args: unknown) => {
      const l = new Live(fn, args);
      subs.push(l);
      return l;
    },
    sql: (s: string) => driver.exec(s).rows,
  };
}
