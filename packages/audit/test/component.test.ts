// The audit component over the real engine (@freecorps/ember-testing): triggers write in the mutation's transaction,
// the diff and the actor, app-level log entries, filtered listing, and the archive: rows go to R2 and are deleted
// after, a crash between the two re-runs idempotently, nothing lost or duplicated, continuation through the scheduler.
import { anyComponents, componentsOf, composeApp, defineApp, defineSchema, defineTable, defineTriggers, internalMutationGeneric, mutationGeneric, queryGeneric, unsafeRef, v, type DataModelFromSchema } from "@freecorps/ember-server";
import type { ActionCtx, MutationCtx, TriggersInput } from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import { describe, expect, test } from "vitest";
import { Audit, audit, auditTriggers, gunzipNdjson, readArchive, REDACTED, type AsyncCtx, type AuditComponentApi, type AuditEntry, type AuditInstallConfig, type SyncWriteCtx } from "../src/index.ts";
import { memoryBucket } from "./fakes.ts";

const DAY = 86_400_000;
const schema = defineSchema({
  tables: {
    users: defineTable({ name: v.string(), email: v.string(), passwordHash: v.string(), lastSeenAt: v.optional(v.number()), role: v.optional(v.string()) }),
    invoices: defineTable({ amount: v.number(), status: v.string() }),
    notes: defineTable({ text: v.string() }),
  },
});

const log = new Audit(anyComponents.audit);
const triggerSpec = auditTriggers(anyComponents.audit, {
  tables: { users: { redact: ["passwordHash"], ignore: ["lastSeenAt"] }, invoices: { fields: ["status"], ops: ["update", "delete"] } },
});
// Typed: what `defineTriggers` of `_generated/server` takes (tables of the app, `Change<Doc<"users">>`).
const typed: TriggersInput<DataModelFromSchema<typeof schema>> = triggerSpec;
void typed;
const triggers = defineTriggers({ ...triggerSpec });

const modules = {
  users: {
    create: mutationGeneric({
      args: { name: v.string(), email: v.string() },
      handler: (ctx: any, a: { name: string; email: string }) => ctx.db.insert("users", { ...a, passwordHash: "h0" }),
    }),
    update: mutationGeneric({ args: { id: v.string(), patch: v.any() }, handler: (ctx: any, a: { id: string; patch: unknown }) => ctx.db.patch(a.id, a.patch) }),
    remove: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: { id: string }) => ctx.db.delete(a.id) }),
    /** Writes, then fails: the transaction (and its audit rows) rolls back. */
    createThenFail: mutationGeneric({
      args: { name: v.string() },
      handler: (ctx: any, a: { name: string }) => {
        ctx.db.insert("users", { name: a.name, email: "x@x.test", passwordHash: "h" });
        throw new Error("boom after the write");
      },
    }),
    note: mutationGeneric({ args: { text: v.string() }, handler: (ctx: any, a: { text: string }) => ctx.db.insert("notes", { text: a.text }) }),
    many: internalMutationGeneric({
      args: { n: v.number() },
      handler: (ctx: any, a: { n: number }) => {
        for (let i = 0; i < a.n; i++) ctx.db.insert("users", { name: `u${i}`, email: `u${i}@x.test`, passwordHash: "h" });
      },
    }),
  },
  invoices: {
    create: mutationGeneric({ args: { amount: v.number() }, handler: (ctx: any, a: { amount: number }) => ctx.db.insert("invoices", { amount: a.amount, status: "draft" }) }),
    send: mutationGeneric({
      args: { id: v.string() },
      handler: (ctx: any, a: { id: string }) => {
        ctx.db.patch(a.id, { status: "sent" });
        return log.log(ctx, { action: "invoice.sent", target: a.id, data: { channel: "email" } });
      },
    }),
    bump: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: { id: string }) => ctx.db.patch(a.id, { amount: 99 }) }),
  },
  read: {
    list: queryGeneric({ args: { o: v.any() }, handler: (ctx: any, a: { o: any }) => log.list(ctx, { paginationOpts: { numItems: 100, cursor: null }, ...a.o }) }),
  },
};

const appWith = (config?: AuditInstallConfig) => defineApp().use(audit, config ? { config } : {});
const typedComponents: { audit: AuditComponentApi } = componentsOf(appWith());
void typedComponents;
// Types: `log` from an action is a Promise (an action's ctx also fits the mutation overload), from a mutation a string.
const typedLog: [(ctx: ActionCtx) => Promise<string>, (ctx: MutationCtx) => string, (ctx: SyncWriteCtx) => string, (ctx: AsyncCtx) => Promise<string>] = [(ctx) => log.log(ctx, { action: "a" }), (ctx) => log.log(ctx, { action: "a" }), (ctx) => log.log(ctx, { action: "a" }), (ctx) => log.log(ctx, { action: "a" })];
void typedLog;

function setup(config?: AuditInstallConfig, bucket = memoryBucket()) {
  const t = emberTest({ schema, modules, app: appWith(config), triggers, env: { EMBER_FILES: bucket } });
  const entries = async (o: Record<string, unknown> = {}, shard?: string) =>
    ((await t.query(unsafeRef<"query">("read:list"), { o }, ...(shard ? [{ shard }] : []))) as { page: AuditEntry[] }).page;
  const internal = (name: string, args: unknown = {}, shard = "global:main") =>
    (t as unknown as { _action(n: string, a: unknown, s: string): Promise<unknown> })._action(`@audit/lib:${name}`, args, shard);
  return { t, bucket, entries, internal };
}

describe("triggers", () => {
  test("one row per audited write, in the same transaction, with the identity as actor", async () => {
    const { t, entries } = setup();
    const ana = t.withIdentity({ subject: "user_ana" });
    const id = (await ana.mutation(unsafeRef<"mutation">("users:create"), { name: "Ana", email: "a@x.test" })) as string;
    await ana.mutation(unsafeRef<"mutation">("users:update"), { id, patch: { email: "ana@x.test", passwordHash: "h1" } });
    await t.mutation(unsafeRef<"mutation">("users:remove"), { id });
    const rows = await entries();
    expect(rows.map((r) => [r.op, r.table, r.docId, r.actor])).toEqual([
      ["delete", "users", id, "system"],
      ["update", "users", id, "user_ana"],
      ["insert", "users", id, "user_ana"],
    ]);
    expect(rows[2]!.diff).toEqual({ name: { to: "Ana" }, email: { to: "a@x.test" }, passwordHash: { to: REDACTED } });
    // The update: only what changed, the password redacted.
    expect(rows[1]!.diff).toEqual({ email: { from: "a@x.test", to: "ana@x.test" }, passwordHash: { from: REDACTED, to: REDACTED } });
    expect(rows[0]!.diff).toEqual({ name: { from: "Ana" }, email: { from: "ana@x.test" }, passwordHash: { from: REDACTED } });
    expect(rows.every((r) => r.at === rows[0]!.at || typeof r.at === "number")).toBe(true);
  });

  test("a failed mutation leaves no audit row (and no document)", async () => {
    const { t, entries } = setup();
    await expect(t.mutation(unsafeRef<"mutation">("users:createThenFail"), { name: "Ghost" })).rejects.toThrow(/boom/);
    expect(await entries()).toEqual([]);
    expect(await t.run((ctx: any) => ctx.db.query("users").collect())).toEqual([]);
  });

  test("ignored fields, field lists and op lists: nothing written when nothing audited changed", async () => {
    const { t, entries } = setup();
    const id = (await t.mutation(unsafeRef<"mutation">("users:create"), { name: "Bo", email: "b@x.test" })) as string;
    await t.mutation(unsafeRef<"mutation">("users:update"), { id, patch: { lastSeenAt: 5 } });
    expect((await entries()).map((r) => r.op)).toEqual(["insert"]);
    // invoices: only `status`, only update/delete.
    const inv = (await t.mutation(unsafeRef<"mutation">("invoices:create"), { amount: 10 })) as string;
    await t.mutation(unsafeRef<"mutation">("invoices:bump"), { id: inv });
    expect(await entries({ table: "invoices" })).toEqual([]);
    await t.mutation(unsafeRef<"mutation">("invoices:send"), { id: inv });
    expect((await entries({ table: "invoices", docId: inv })).map((r) => [r.op, r.diff])).toEqual([["update", { status: { from: "draft", to: "sent" } }]]);
    // An unaudited table: no trigger at all.
    await t.mutation(unsafeRef<"mutation">("users:note"), { text: "hi" });
    expect((await entries()).filter((r) => r.table === "notes")).toEqual([]);
  });

  test("cost: an audited write is the document's row plus one audit row (and its index entries)", async () => {
    const { t } = setup();
    await t.mutation(unsafeRef<"mutation">("users:note"), { text: "x" });
    const plain = t.lastStats()!.rowsWritten;
    await t.mutation(unsafeRef<"mutation">("users:create"), { name: "C", email: "c@x.test" });
    const audited = t.lastStats()!.rowsWritten;
    // The audit row: 1 document row + its 3 index entries (by_at, by_table_doc, by_actor).
    expect(audited - plain).toBeLessThanOrEqual(4);
    expect(audited).toBeGreaterThan(plain);
  });

  test("audit.log: app events in the mutation's transaction, filtered by op", async () => {
    const { t, entries } = setup();
    const inv = (await t.mutation(unsafeRef<"mutation">("invoices:create"), { amount: 10 })) as string;
    await t.withIdentity({ subject: "user_ops" }).mutation(unsafeRef<"mutation">("invoices:send"), { id: inv });
    const logs = await entries({ op: "log" });
    expect(logs.map((r) => [r.action, r.docId, r.actor, r.data])).toEqual([["invoice.sent", inv, "user_ops", { channel: "email" }]]);
  });
});

describe("listing", () => {
  test("filters: table + document, actor, op, time range; newest first, paginated", async () => {
    const { t, entries } = setup();
    const a = t.withIdentity({ subject: "alice" });
    const b = t.withIdentity({ subject: "bob" });
    const u1 = (await a.mutation(unsafeRef<"mutation">("users:create"), { name: "1", email: "1@x.test" })) as string;
    await t.advance(1000);
    const u2 = (await b.mutation(unsafeRef<"mutation">("users:create"), { name: "2", email: "2@x.test" })) as string;
    await t.advance(1000);
    await b.mutation(unsafeRef<"mutation">("users:update"), { id: u1, patch: { role: "admin" } });
    expect((await entries({ table: "users", docId: u1 })).map((r) => r.op)).toEqual(["update", "insert"]);
    expect((await entries({ actor: "bob" })).map((r) => [r.op, r.docId])).toEqual([["update", u1], ["insert", u2]]);
    expect((await entries({ actor: "bob", op: "insert" })).map((r) => r.docId)).toEqual([u2]);
    // Every filter given applies, whichever index the range used: (table, docId) + actor, and docId alone.
    expect((await entries({ table: "users", docId: u1, actor: "bob" })).map((r) => r.op)).toEqual(["update"]);
    expect((await entries({ table: "users", docId: u1, actor: "alice" })).map((r) => r.op)).toEqual(["insert"]);
    expect((await entries({ docId: u2 })).map((r) => [r.op, r.docId])).toEqual([["insert", u2]]);
    expect((await entries({ actor: "bob", docId: u1 })).map((r) => r.op)).toEqual(["update"]);
    const all = await entries();
    const t1 = all[1]!.at;
    expect((await entries({ from: t1 })).length).toBe(2);
    expect((await entries({ to: t1 })).map((r) => r.docId)).toEqual([u1]);
    expect((await entries({ table: "users", from: t1, to: t1 + 1 })).map((r) => r.docId)).toEqual([u2]);
    const page = (await t.query(unsafeRef<"query">("read:list"), { o: { paginationOpts: { numItems: 2, cursor: null } } })) as { page: AuditEntry[]; isDone: boolean; continueCursor: string };
    expect([page.page.length, page.isDone]).toEqual([2, false]);
    const rest = (await t.query(unsafeRef<"query">("read:list"), { o: { paginationOpts: { numItems: 2, cursor: page.continueCursor } } })) as { page: AuditEntry[]; isDone: boolean };
    expect([rest.page.length, rest.isDone]).toEqual([1, true]);
  });
});

describe("archive", () => {
  async function seed(t: ReturnType<typeof setup>["t"], n: number) {
    await t.mutation(unsafeRef<"mutation">("users:many"), { n });
  }

  test("rows past the retention go to R2 as gzip NDJSON, then leave the shard; recent rows stay", async () => {
    const { t, bucket, entries, internal } = setup({ retainDays: 30 });
    await seed(t, 5);
    await t.advance(31 * DAY);
    await t.mutation(unsafeRef<"mutation">("users:create"), { name: "recent", email: "r@x.test" });
    const old = (await entries()).filter((r) => r.docId !== "").slice(1);
    const r = (await internal("archive")) as { key: string; archived: number; deleted: number; more: boolean };
    expect(r).toMatchObject({ archived: 5, deleted: 5, more: false, skippedPut: false });
    expect(r.key).toMatch(/^audit\/audit\/\d{4}\/\d{2}\/\d{2}\/\d+-[0-9a-f]{8}\.ndjson\.gz$/);
    const obj = bucket.objects.get(r.key)!;
    expect(obj.customMetadata).toMatchObject({ count: "5" });
    const lines = (await gunzipNdjson(obj.body)) as AuditEntry[];
    expect(lines.map((l) => l._id).sort()).toEqual(old.map((o) => o._id).sort());
    expect(await readArchive(bucket, r.key)).toEqual(lines);
    const left = await entries();
    expect(left.map((e) => e.diff?.name)).toEqual([{ to: "recent" }]);
    // Nothing more past the retention: a run does nothing.
    expect(await internal("archive")).toMatchObject({ batch: null, deleted: 0 });
    // The archives list (R2) and the batch rows (the dashboard's list).
    const listed = (await internal("archives")) as { objects: Array<{ key: string; count: number }> };
    expect(listed.objects).toEqual([expect.objectContaining({ key: r.key, count: 5 })]);
    const batches = (await t.query(unsafeRef<"query">("@audit/dashboard:batches"), { paginationOpts: { numItems: 10, cursor: null } })) as { page: Array<{ state: string; count: number; ids?: unknown }> };
    expect(batches.page).toEqual([expect.objectContaining({ state: "archived", count: 5 })]);
    expect(batches.page[0]!.ids).toBeUndefined();
    const read = (await internal("readArchive", { key: r.key, limit: 2 })) as { total: number; entries: unknown[]; next: number | null };
    expect([read.total, read.entries.length, read.next]).toEqual([5, 2, 2]);
    await expect(internal("readArchive", { key: "f/secret-file" })).rejects.toThrow(/not an archive/);
  });

  test("a crash between the R2 write and the delete: the re-run finds the object, deletes once, writes nothing twice", async () => {
    const bucket = memoryBucket();
    let crash = true;
    const flaky = {
      ...bucket,
      head: bucket.head.bind(bucket),
      get: bucket.get.bind(bucket),
      list: bucket.list.bind(bucket),
      put: async (k: string, body: Uint8Array, o: never) => {
        await bucket.put(k, body, o);
        if (crash) {
          crash = false;
          throw new Error("worker died after the write");
        }
      },
    };
    const { t, entries, internal } = setup({ retainDays: 1 }, flaky as never);
    await seed(t, 4);
    await t.advance(2 * DAY);
    const before = (await entries()).map((e) => e._id).sort();
    await expect(internal("archive")).rejects.toThrow(/died/);
    // The object is there, the rows too (nothing lost), the batch is pending.
    expect(bucket.objects.size).toBe(1);
    expect((await entries()).length).toBe(4);
    const r = (await internal("archive")) as { key: string; deleted: number; skippedPut: boolean; archived: number };
    expect(r).toMatchObject({ deleted: 4, skippedPut: true, archived: 4 });
    expect(bucket.puts).toBe(1);
    expect(bucket.objects.size).toBe(1);
    expect(await entries()).toEqual([]);
    const archived = ((await gunzipNdjson(bucket.objects.get(r.key)!.body)) as AuditEntry[]).map((e) => e._id).sort();
    expect(archived).toEqual(before);
    // A late duplicate of the delete (a retried job) does nothing.
    const [batch] = ((await t.query(unsafeRef<"query">("@audit/dashboard:batches"), { paginationOpts: { numItems: 1, cursor: null } })) as { page: Array<{ _id: string }> }).page;
    expect(await t.mutation(unsafeRef<"mutation">("@audit/lib:commit"), { id: batch!._id, bytes: 0 })).toEqual({ deleted: 0, more: false });
  });

  test("two overlapping runs of one batch: the late one never replaces the archive with an empty object", async () => {
    const bucket = memoryBucket();
    let other: (() => Promise<unknown>) | null = null;
    const racing = {
      ...bucket,
      get: bucket.get.bind(bucket),
      list: bucket.list.bind(bucket),
      put: bucket.put.bind(bucket),
      // Run A looks for the object, finds none, and before it reads the rows run B archives the whole batch.
      head: async (k: string) => {
        const there = await bucket.head(k);
        const b = other;
        other = null;
        if (b) await b();
        return there;
      },
    };
    const { t, entries, internal } = setup({ retainDays: 1 }, racing as never);
    await seed(t, 3);
    await t.advance(2 * DAY);
    const before = (await entries()).map((e) => e._id).sort();
    other = () => internal("archive");
    const a = (await internal("archive")) as { key: string; skippedPut: boolean; deleted: number };
    expect(a).toMatchObject({ skippedPut: true, deleted: 0 });
    expect(bucket.puts).toBe(1);
    const archived = ((await gunzipNdjson(bucket.objects.get(a.key)!.body)) as AuditEntry[]).map((e) => e._id).sort();
    expect(archived).toEqual(before);
    expect(await entries()).toEqual([]);
  });

  test("a crash before the write: the re-run writes the same batch once", async () => {
    const bucket = memoryBucket();
    let fail = true;
    const flaky = { ...bucket, head: bucket.head.bind(bucket), get: bucket.get.bind(bucket), list: bucket.list.bind(bucket), put: async (k: string, b: Uint8Array, o: never) => { if (fail) { fail = false; throw new Error("R2 unavailable"); } return bucket.put(k, b, o); } };
    const { t, entries, internal } = setup({ retainDays: 1 }, flaky as never);
    await seed(t, 3);
    await t.advance(2 * DAY);
    await expect(internal("archive")).rejects.toThrow(/unavailable/);
    expect(bucket.objects.size).toBe(0);
    expect((await entries()).length).toBe(3);
    await expect(internal("archive")).resolves.toMatchObject({ deleted: 3, skippedPut: false });
    expect(bucket.objects.size).toBe(1);
    expect(await entries()).toEqual([]);
  });

  test("bounded batches continue through the scheduler until the backlog is gone; every row lands exactly once", async () => {
    const { t, bucket, entries, internal } = setup({ retainDays: 1, batchSize: 40 });
    await seed(t, 100);
    await t.advance(2 * DAY);
    const all = (await entries({ paginationOpts: { numItems: 200, cursor: null } })).map((e) => e._id).sort();
    expect(all).toHaveLength(100);
    expect(await internal("archive")).toMatchObject({ archived: 40, more: true });
    await t.finishScheduled();
    expect(await entries()).toEqual([]);
    expect(bucket.objects.size).toBe(3);
    const counts = [...bucket.objects.values()].map((o) => Number(o.customMetadata.count)).sort((a, b) => a - b);
    expect(counts).toEqual([20, 40, 40]);
    const ids: string[] = [];
    for (const o of bucket.objects.values()) ids.push(...((await gunzipNdjson(o.body)) as AuditEntry[]).map((e) => e._id));
    expect(ids.sort()).toEqual(all);
  });

  test("archive: false only deletes; without a bucket the archive refuses (rows stay)", async () => {
    const off = setup({ retainDays: 1, archive: false });
    await seed(off.t, 2);
    await off.t.advance(2 * DAY);
    expect(await off.internal("archive")).toMatchObject({ key: null, deleted: 2 });
    expect(off.bucket.objects.size).toBe(0);
    const t = emberTest({ schema, modules, app: appWith({ retainDays: 1 }), triggers, env: {} });
    await t.mutation(unsafeRef<"mutation">("users:many"), { n: 1 });
    await t.advance(2 * DAY);
    const run = (t as unknown as { _action(n: string, a: unknown, s: string): Promise<unknown> })._action("@audit/lib:archive", {}, "global:main");
    await expect(run).rejects.toThrow(/no R2 bucket EMBER_FILES/);
  });

  test("the cron's run fans out to the shards of `shardKinds` (rows live in each mutation's shard)", async () => {
    const { t, bucket, entries, internal } = setup({ retainDays: 1, shardKinds: ["org"] });
    await t.mutation(unsafeRef<"mutation">("users:create"), { name: "a", email: "a@x.test" }, { shard: "org:a" });
    await t.mutation(unsafeRef<"mutation">("users:create"), { name: "b", email: "b@x.test" }, { shard: "org:b" });
    await t.mutation(unsafeRef<"mutation">("users:create"), { name: "g", email: "g@x.test" });
    await t.advance(2 * DAY);
    expect(await internal("archive", { fanOut: true })).toMatchObject({ shards: 2, deleted: 1 });
    await t.finishScheduled();
    expect(await entries({}, "org:a")).toEqual([]);
    expect(await entries({}, "org:b")).toEqual([]);
    expect(bucket.objects.size).toBe(3);
  });
});

describe("the install", () => {
  test("a daily cron with fanOut, the screen with the component's own functions", () => {
    const composed = composeApp({ schema, functions: modules, app: appWith({ hour: 5 }) });
    expect(composed.crons.map((c) => [c.name, c.fn, c.schedule, c.args])).toEqual([["@audit/archive", "@audit/lib:archive", "0 5 * * *", { fanOut: true }]]);
    const [spec] = composed.dashboards;
    expect(spec).toMatchObject({ key: "audit", component: "audit", scope: "shard", icon: "shield" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@audit/dashboard:archiveNow", "@audit/dashboard:batches", "@audit/dashboard:stats", "@audit/lib:get", "@audit/lib:list", "@audit/lib:readArchive"]);
    expect(spec!.tabs[0]!.blocks[1]).toMatchObject({ kind: "table", query: "@audit/lib:list", filters: ["table", "actor", "op", "docId"] });
  });
});
