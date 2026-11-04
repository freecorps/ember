// Subscriptions: run a query recording its read set; after each commit, re-run only the subscriptions whose
// read set a changed row overlaps (in its old or new version), diff old vs new result, emit a patch.

import { overlaps, type Engine } from "./engine";
import type { RegisteredFunction } from "./server";
import type { Doc, ReadSetEntry, RowChange } from "./types";
import { toJson } from "./values";

export type ResultDiff =
  | { kind: "docs"; added: Doc[]; removed: string[]; changed: Doc[]; order: string[] }
  | { kind: "value"; value: unknown };

export type Patch = { subId: string; value: unknown; diff: ResultDiff };

type Sub = {
  id: string;
  fn: RegisteredFunction<"query", any, any, any>;
  args: unknown;
  readSet: ReadSetEntry[];
  value: unknown;
  json: string;
};

export class SubscriptionManager {
  private subs = new Map<string, Sub>();
  /** Stats for tests / metrics: how many re-runs each commit caused. */
  lastRerun: string[] = [];

  constructor(private readonly engine: Engine) {}

  async subscribe(id: string, fn: RegisteredFunction<"query", any, any, any>, args: unknown = {}) {
    const { value, readSet } = await this.engine.runQuery(fn, args);
    this.subs.set(id, { id, fn, args, readSet, value, json: toJson(value) });
    return value;
  }

  unsubscribe(id: string) {
    this.subs.delete(id);
  }

  readSetOf(id: string) {
    return this.subs.get(id)?.readSet;
  }

  valueOf(id: string) {
    return this.subs.get(id)?.value;
  }

  /** Which subscriptions `changes` may affect (pure; no re-run). */
  invalidated(changes: RowChange[]): string[] {
    const out: string[] = [];
    for (const sub of this.subs.values()) {
      if (changes.some((c) => sub.readSet.some((e) => overlaps(e, c)))) out.push(sub.id);
    }
    return out;
  }

  /** After a commit: re-run invalidated subscriptions, return a patch for each whose result changed. */
  async onCommit(changes: RowChange[]): Promise<Patch[]> {
    const ids = this.invalidated(changes);
    this.lastRerun = ids;
    const patches: Patch[] = [];
    for (const id of ids) {
      const sub = this.subs.get(id)!;
      const { value, readSet } = await this.engine.runQuery(sub.fn, sub.args);
      const json = toJson(value);
      const before = sub.value;
      sub.readSet = readSet; // the new run may cover a different range (take(n) moved, ...)
      sub.value = value;
      if (json === sub.json) continue;
      sub.json = json;
      patches.push({ subId: id, value, diff: diff(before, value) });
    }
    return patches;
  }
}

const isDocArray = (x: unknown): x is Doc[] => Array.isArray(x) && x.every((d) => d && typeof d === "object" && typeof (d as Doc)._id === "string");

/** Row-level diff for document lists (what goes on the wire), whole value otherwise. */
export function diff(before: unknown, after: unknown): ResultDiff {
  if (!isDocArray(before) || !isDocArray(after)) return { kind: "value", value: after };
  const old = new Map(before.map((d) => [d._id, toJson(d)]));
  const now = new Set(after.map((d) => d._id));
  return {
    kind: "docs",
    added: after.filter((d) => !old.has(d._id)),
    removed: [...old.keys()].filter((id) => !now.has(id)),
    changed: after.filter((d) => old.has(d._id) && old.get(d._id) !== toJson(d)),
    order: after.map((d) => d._id),
  };
}
