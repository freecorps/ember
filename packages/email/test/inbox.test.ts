// Conversation features of the inbox: exact lists by assignee / unread / tag, the stored `hasUnread` flag, counts
// from aggregates, tags (labels) and the activity timeline. Invariants are checked against brute-force recounts
// over random operations.
import { componentBuilders, composeApp, createEngine, defineApp, defineComponent, defineSchema, defineTable, v } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { email } from "../src/index.ts";
import { event, inboxHarness, schema } from "./harness.ts";

type H = ReturnType<typeof inboxHarness>;
const STATUSES = ["open", "waiting", "closed", "spam"] as const;

/** Every thread of a mailbox, newest first (one big page of the unfiltered list). */
const allThreads = (h: H, mailbox = "support"): any[] => h.query("@email/lib:threads", { mailbox, paginationOpts: { numItems: 100_000, cursor: null } }).page;

/** Pages through `threads` with `args`, 3 at a time, and returns the ids in order. */
function listIds(h: H, args: Record<string, unknown>): string[] {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const r: any = h.query("@email/lib:threads", { mailbox: "support", ...args, paginationOpts: { numItems: 3, cursor } });
    ids.push(...r.page.map((t: any) => t._id));
    if (r.isDone) return ids;
    cursor = r.continueCursor;
  }
  throw new Error("did not finish");
}

/** What a list must hold: the brute-force filter of every thread, in the list order (newest message first). */
function expectedIds(h: H, f: { status?: string; assignee?: string | null; unread?: boolean; tag?: string }): string[] {
  return allThreads(h)
    .filter((t) => f.status === undefined || t.status === f.status)
    .filter((t) => f.assignee === undefined || (f.assignee === null ? t.assignee === undefined : t.assignee === f.assignee))
    .filter((t) => f.unread === undefined || t.unreadCount > 0 === f.unread)
    .filter((t) => f.tag === undefined || (t.tags ?? []).includes(f.tag))
    .map((t) => t._id);
}

const zero = () => ({ threads: 0, unread: 0, unreadThreads: 0 });
/** The counts recomputed from the threads themselves. */
function recount(threads: any[], tagIds: string[]) {
  const make = () => ({ all: zero(), byStatus: Object.fromEntries(STATUSES.map((s) => [s, zero()])) as Record<string, ReturnType<typeof zero>> });
  const add = (c: ReturnType<typeof make>, t: any) => {
    for (const b of [c.all, c.byStatus[t.status]!]) {
      b.threads++;
      b.unread += t.unreadCount;
      if (t.unreadCount > 0) b.unreadThreads++;
    }
  };
  const mailbox = make();
  const mine = make();
  const unassigned = make();
  const tags: Record<string, ReturnType<typeof make>> = Object.fromEntries(tagIds.map((id) => [id, make()]));
  for (const t of threads) {
    add(mailbox, t);
    if (t.assignee === "u1") add(mine, t);
    if (t.assignee === undefined) add(unassigned, t);
    for (const id of t.tags ?? []) if (tags[id]) add(tags[id]!, t);
  }
  return { mailbox, mine, unassigned, tags };
}

/** A small deterministic PRNG (tests must replay). */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const noLimit = { rateLimit: { rate: 1_000_000, period: 60_000 } };

/** Every invariant the component keeps between a thread and its derived rows. */
function checkInvariants(h: H, tagIds: string[]) {
  const threads = allThreads(h);
  for (const t of threads) expect(t.hasUnread, `hasUnread of #${t.number}`).toBe(t.unreadCount > 0);
  // Lists equal the brute-force filters.
  for (const status of [undefined, ...STATUSES]) {
    for (const f of [{}, { assignee: "u1" }, { assignee: null }, { unread: true }, { unread: false }, ...tagIds.map((tag) => ({ tag })), { tag: tagIds[0], unread: true }, { tag: tagIds[1], assignee: null }, { assignee: "u2", unread: true }]) {
      const args = { ...(status ? { status } : {}), ...f };
      expect(listIds(h, args), JSON.stringify(args)).toEqual(expectedIds(h, args as any));
    }
  }
  // Counts equal a recount.
  const want = recount(threads, tagIds);
  const c = h.query("@email/lib:counts", { mailbox: "support", assignee: "u1" });
  expect({ all: c.all, byStatus: c.byStatus }).toEqual(want.mailbox);
  expect(c.assignee).toEqual(want.mine);
  expect(c.tags).toEqual(want.tags);
  expect(h.query("@email/lib:counts", { mailbox: "support", assignee: null }).assignee).toEqual(want.unassigned);
  // The legacy aggregate agrees.
  expect(h.query("@email/lib:unread", { mailboxes: ["support"] }).support).toEqual({ unread: want.mailbox.all.unread, threads: want.mailbox.all.threads });
}

describe("conversation lists, flags and counts", () => {
  test("random operations: lists, the unread flag and counts always match a brute-force recount", async () => {
    const h = inboxHarness(noLimit);
    const tagIds = ["Billing", "Bug", "VIP"].map((name, i) => h.mutate("@email/lib:createTag", { mailbox: "support", name, color: ["red", "blue", "green"][i] }));
    const rand = rng(42);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const live = () => allThreads(h).map((t) => t._id as string);
    for (let i = 0; i < 12; i++) h.ingest({ subject: `Topic ${i}`, from: { email: `c${i}@user.test` } });
    for (let step = 0; step < 400; step++) {
      h.advance(1000);
      const ids = live();
      const t = pick(ids);
      const op = Math.floor(rand() * 13);
      if (op === 0) h.ingest({ subject: `Topic ${Math.floor(rand() * 30)}`, from: { email: `c${Math.floor(rand() * 30)}@user.test` } });
      else if (op === 1) h.mutate("@email/lib:markRead", { threadId: t });
      else if (op === 2) h.mutate("@email/lib:markUnread", { threadId: t });
      else if (op === 3) {
        const th = allThreads(h).find((x) => x._id === t);
        if (th.status !== "spam") h.mutate("@email/lib:reply", { threadId: t, text: `reply ${step}`, author: "Bia" });
      } else if (op === 4) h.mutate("@email/lib:note", { threadId: t, text: `note ${step}` });
      else if (op === 5) h.mutate("@email/lib:setStatus", { threadId: t, status: pick(STATUSES), author: "Bia" });
      else if (op === 6) h.mutate("@email/lib:assign", { threadId: t, assignee: pick(["u1", "u2", null]), assigneeName: "X" });
      else if (op === 7) h.mutate("@email/lib:addTag", { threadId: t, tag: pick(tagIds) });
      else if (op === 8) h.mutate("@email/lib:removeTag", { threadId: t, tag: pick(tagIds) });
      else if (op === 9) h.mutate("@email/lib:setTags", { threadId: t, tags: tagIds.filter(() => rand() < 0.5) });
      else if (op === 10 && ids.length > 8) h.mutate("@email/lib:deleteThread", { threadId: t });
      else if (op === 11) h.mutate("@email/lib:compose", { mailbox: "support", to: [`n${step}@user.test`], subject: `New ${step}`, text: "hi" });
      else if (op === 12) {
        // An answer to an existing thread (same contact and subject).
        const th = allThreads(h).find((x) => x._id === t);
        if (th.status !== "closed" && th.status !== "spam") h.ingest({ subject: th.subject, from: { email: th.contact } });
      }
      if (step % 50 === 49) checkInvariants(h, tagIds);
    }
    await h.tick();
    checkInvariants(h, tagIds);
    // The threadTags rows mirror the threads exactly.
    for (const t of allThreads(h)) {
      for (const tag of tagIds) expect(listIds(h, { tag }).includes(t._id)).toBe((t.tags ?? []).includes(tag));
    }
  });

  test("assignee, unread and tag filters; unknown tag ids list nothing; existing args keep working", () => {
    const h = inboxHarness(noLimit);
    const a = h.ingest({ subject: "A", from: { email: "a@user.test" } });
    h.advance(1);
    const b = h.ingest({ subject: "B", from: { email: "b@user.test" } });
    h.advance(1);
    const c = h.ingest({ subject: "C", from: { email: "c@user.test" } });
    h.mutate("@email/lib:assign", { threadId: a.threadId, assignee: "u1", assigneeName: "Bia" });
    h.mutate("@email/lib:assign", { threadId: c.threadId, assignee: "u1", assigneeName: "Bia" });
    h.mutate("@email/lib:markRead", { threadId: c.threadId });
    h.mutate("@email/lib:setStatus", { threadId: a.threadId, status: "waiting" });
    expect(listIds(h, { assignee: "u1" })).toEqual([c.threadId, a.threadId]);
    expect(listIds(h, { assignee: "u1", status: "waiting" })).toEqual([a.threadId]);
    expect(listIds(h, { assignee: null })).toEqual([b.threadId]);
    expect(listIds(h, { unread: true })).toEqual([b.threadId, a.threadId]);
    expect(listIds(h, { unread: false })).toEqual([c.threadId]);
    expect(listIds(h, { unread: true, status: "open" })).toEqual([b.threadId]);
    expect(listIds(h, { assignee: "u1", unread: true })).toEqual([a.threadId]);
    expect(listIds(h, { tag: "nope" })).toEqual([]);
    expect(listIds(h, {})).toEqual([c.threadId, b.threadId, a.threadId]);
    expect(listIds(h, { status: "open" })).toEqual([c.threadId, b.threadId]);
    // Lists are reactive on the flag: reading marks it, the unread list follows.
    h.mutate("@email/lib:markRead", { threadId: b.threadId });
    expect(listIds(h, { unread: true })).toEqual([a.threadId]);
  });
});

describe("tags", () => {
  test("create, update, order, validation; per-thread add/remove/set with their mailbox's tags only", () => {
    const h = inboxHarness(noLimit);
    const bug = h.mutate("@email/lib:createTag", { mailbox: "support", name: "  Bug  ", color: "red" });
    const vip = h.mutate("@email/lib:createTag", { mailbox: "support", name: "VIP" });
    const other = h.mutate("@email/lib:createTag", { mailbox: "privacy", name: "Bug" });
    expect(h.query("@email/lib:tags", { mailbox: "support" }).map((t: any) => [t.name, t.color, t.order])).toEqual([
      ["Bug", "red", 0],
      ["VIP", "gray", 1],
    ]);
    expect(() => h.mutate("@email/lib:createTag", { mailbox: "support", name: "bug" })).toThrow(/already has a tag/);
    expect(() => h.mutate("@email/lib:createTag", { mailbox: "support", name: "x", color: "chartreuse" })).toThrow(/tag color/);
    expect(() => h.mutate("@email/lib:createTag", { mailbox: "support", name: " " })).toThrow(/1\.\.40/);
    expect(() => h.mutate("@email/lib:createTag", { mailbox: "nope", name: "x" })).toThrow(/not found/);
    h.mutate("@email/lib:updateTag", { tagId: vip, name: "Priority", color: "purple", order: -1 });
    expect(() => h.mutate("@email/lib:updateTag", { tagId: vip, name: "BUG" })).toThrow(/already has a tag/);
    expect(h.query("@email/lib:tags", { mailbox: "support" }).map((t: any) => t.name)).toEqual(["Priority", "Bug"]);

    const t = h.ingest({});
    expect(h.mutate("@email/lib:addTag", { threadId: t.threadId, tag: bug })).toEqual([bug]);
    expect(h.mutate("@email/lib:addTag", { threadId: t.threadId, tag: bug })).toEqual([bug]);
    expect(h.mutate("@email/lib:addTag", { threadId: t.threadId, tag: vip })).toEqual([bug, vip]);
    expect(() => h.mutate("@email/lib:addTag", { threadId: t.threadId, tag: other })).toThrow(/not a tag of mailbox support/);
    expect(h.mutate("@email/lib:removeTag", { threadId: t.threadId, tag: bug })).toEqual([vip]);
    expect(h.mutate("@email/lib:setTags", { threadId: t.threadId, tags: [] })).toEqual([]);
    expect(h.query("@email/lib:thread", { threadId: t.threadId }).thread.tags).toBeUndefined();
    expect(() => h.mutate("@email/lib:setTags", { threadId: "nope", tags: [] })).toThrow(/thread not found/);
  });

  test("deleting a tag takes it off every thread (in batches past 200) and out of the counts", async () => {
    const h = inboxHarness(noLimit);
    const bug = h.mutate("@email/lib:createTag", { mailbox: "support", name: "Bug" });
    const keep = h.mutate("@email/lib:createTag", { mailbox: "support", name: "Keep" });
    const threads = Array.from({ length: 205 }, (_, i) => h.ingest({ subject: `T${i}`, from: { email: `t${i}@user.test` } }).threadId);
    for (const id of threads) h.mutate("@email/lib:setTags", { threadId: id, tags: [bug, keep] });
    expect(h.query("@email/lib:counts", { mailbox: "support" }).tags[bug].all.threads).toBe(205);
    expect(h.mutate("@email/lib:deleteTag", { tagId: bug })).toEqual({ deleted: true });
    expect(h.query("@email/lib:counts", { mailbox: "support" }).tags[bug]).toBeUndefined();
    // 200 untagged at once; the other 5 by the job it scheduled.
    const stale = allThreads(h).filter((t) => t.tags?.includes(bug));
    expect(stale).toHaveLength(5);
    // Until the job runs, those threads can still be tagged: the deleted id is dropped, not an error.
    expect(h.mutate("@email/lib:addTag", { threadId: stale[0]._id, tag: keep })).toEqual([keep]);
    await h.tick();
    expect(allThreads(h).filter((t) => t.tags?.includes(bug))).toHaveLength(0);
    expect(allThreads(h).every((t) => t.tags?.length === 1 && t.tags[0] === keep)).toBe(true);
    expect(listIds(h, { tag: bug })).toEqual([]);
    expect(listIds(h, { tag: keep })).toHaveLength(205);
    expect(h.query("@email/lib:counts", { mailbox: "support" }).tags[keep].all.threads).toBe(205);
    expect(h.mutate("@email/lib:deleteTag", { tagId: bug })).toEqual({ deleted: false });
    // Deleting a thread removes its tag rows: the counts follow at once.
    h.mutate("@email/lib:deleteThread", { threadId: threads[0] });
    expect(h.query("@email/lib:counts", { mailbox: "support" }).tags[keep].all.threads).toBe(204);
  });
});

describe("activity timeline", () => {
  test("status changes, assignments, tags and delivery outcomes, oldest first, with their author", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({ messageId: "first@user.test" });
    const tag = h.mutate("@email/lib:createTag", { mailbox: "support", name: "Bug", color: "red" });
    h.advance(10);
    h.mutate("@email/lib:assign", { threadId: t.threadId, assignee: "u1", assigneeName: "Bia", author: "Caio" });
    h.mutate("@email/lib:assign", { threadId: t.threadId, assignee: "u1", assigneeName: "Bia", author: "Caio" }); // no change, no entry
    h.advance(10);
    h.mutate("@email/lib:addTag", { threadId: t.threadId, tag, author: "Bia" });
    h.advance(10);
    const r = h.mutate("@email/lib:reply", { threadId: t.threadId, text: "On it", author: "Bia" });
    await h.tick(); // the auto-reply and the reply go out
    const mid = h.get(r.emailId).messageId;
    h.mutate("@email/lib:applyEvents", { events: [event("delivered", mid)] });
    h.mutate("@email/lib:applyEvents", { events: [event("delivered", mid, {}, "dup")] }); // same status: no entry
    h.advance(10);
    h.mutate("@email/lib:setStatus", { threadId: t.threadId, status: "closed", author: "Bia" });
    h.advance(10);
    h.ingest({ inReplyTo: "first@user.test", subject: "Re: Order 42 is late" }); // reopens it (no author)
    h.mutate("@email/lib:removeTag", { threadId: t.threadId, tag });
    h.mutate("@email/lib:assign", { threadId: t.threadId, assignee: null });

    const log = h.query("@email/lib:activity", { threadId: t.threadId });
    const brief = log.map((e: any) => [e.kind, e.author ?? null, e.data]);
    const replyMessage = h.query("@email/lib:thread", { threadId: t.threadId }).messages.find((m: any) => m.direction === "outbound")._id;
    const autoReply = brief.filter((e: any) => e[0] === "delivery" && e[2].messageId === undefined);
    expect(autoReply.map((e: any) => e[2].status)).toEqual(["sent"]); // the auto-reply is no thread message
    expect(brief.filter((e: any) => !(e[0] === "delivery" && e[2].messageId === undefined))).toEqual([
      ["assigned", "Caio", { from: null, to: "u1", toName: "Bia" }],
      ["tag_added", "Bia", { tag, name: "Bug", color: "red" }],
      ["status", "Bia", { from: "open", to: "waiting" }],
      ["delivery", null, { emailId: r.emailId, status: "sent", previous: "sending", messageId: replyMessage }],
      ["delivery", null, { emailId: r.emailId, status: "delivered", previous: "sent", messageId: replyMessage, recipient: "ana@user.test" }],
      ["status", "Bia", { from: "waiting", to: "closed" }],
      ["status", null, { from: "closed", to: "open" }],
      ["tag_removed", null, { tag, name: "Bug", color: "red" }],
      ["assigned", null, { from: "u1", fromName: "Bia", to: null }],
    ]);
    expect(log.map((e: any) => e.at)).toEqual([...log.map((e: any) => e.at)].sort((x: number, y: number) => x - y));
    expect(h.query("@email/lib:activity", { threadId: t.threadId, limit: 2 }).map((e: any) => e.kind)).toEqual(["tag_removed", "assigned"]);
    expect(h.query("@email/lib:activity", { threadId: "nope" })).toEqual([]);
    // A failed send and a canceled one are recorded too.
    const later = h.mutate("@email/lib:reply", { threadId: t.threadId, text: "later", sendAt: h.now() + 60_000 });
    h.mutate("@email/lib:cancel", { id: later.emailId });
    expect(h.query("@email/lib:activity", { threadId: t.threadId }).at(-1)).toMatchObject({ kind: "delivery", data: { emailId: later.emailId, status: "canceled", previous: "scheduled" } });
    // The timeline goes with the thread.
    h.mutate("@email/lib:deleteThread", { threadId: t.threadId });
    expect(h.query("@email/lib:activity", { threadId: t.threadId })).toEqual([]);
  });
});

describe("upgrade from 0.6", () => {
  test("threads stored before hasUnread get it from lib:maintain once the new indexes are backfilled", () => {
    // The 0.6 threads table (the fields that matter), installed as `email` on the same database.
    const old = defineComponent({
      name: "email",
      schema: defineSchema({
        tables: {
          threads: defineTable({
            mailbox: v.string(),
            number: v.number(),
            subject: v.string(),
            subjectKey: v.string(),
            contact: v.string(),
            contactName: v.optional(v.string()),
            status: v.string(),
            activityAt: v.optional(v.number()),
            token: v.string(),
            messageCount: v.number(),
            unreadCount: v.number(),
            lastMessageAt: v.number(),
            lastInboundAt: v.optional(v.number()),
            snippet: v.string(),
            assignee: v.optional(v.string()),
            assigneeName: v.optional(v.string()),
          })
            .index("by_mailbox_last", ["mailbox", "lastMessageAt"])
            .aggregate("unread", { by: ["mailbox"], count: true, sum: ["unreadCount"] }),
        },
      }),
      functions: (() => {
        const { internalMutation } = componentBuilders<any>();
        return {
          lib: {
            seed: internalMutation({
              args: { n: v.number() },
              handler: (ctx: any, a: any) => {
                for (let i = 0; i < a.n; i++) {
                  ctx.db.insert("threads", { mailbox: "support", number: i + 1, subject: `s${i}`, subjectKey: `s${i}`, contact: `c${i}@x.test`, status: "open", token: `t${i}`, messageCount: 1, unreadCount: i % 3, lastMessageAt: i, snippet: "" });
                }
                return null;
              },
            }),
          },
        };
      })(),
    });
    const driver = createNodeSqliteDriver();
    const app0 = composeApp({ schema, functions: {}, app: defineApp().use(old) });
    const e0 = createEngine({ schema: app0.schema, functions: app0.functions, driver, now: () => 1 });
    e0.migrate();
    e0.runMutation("@email/lib:seed", { n: 1200 });

    const app1 = composeApp({ schema, functions: {}, app: defineApp().use(email, { config: {} as any }) });
    const e1 = createEngine({ schema: app1.schema, functions: app1.functions, driver, now: () => 2 });
    const report = e1.migrate();
    expect(report.staged.map((s: any) => s.index)).toEqual(expect.arrayContaining(["by_mailbox_unread", "by_status", "by_assignee"]));
    // While the index backfills, the cron run waits.
    expect(e1.runMutation("@email/lib:maintain", {}).value).toMatchObject({ waiting: true });
    while (!e1.backfillStep(500).done);
    const run = e1.runMutation("@email/lib:maintain", {});
    expect(run.value).toEqual({ filled: 500, more: true });
    expect(run.scheduled.map((j: any) => j.fn)).toEqual(["@email/lib:maintain"]);
    expect(e1.runMutation("@email/lib:maintain", {}).value).toEqual({ filled: 500, more: true });
    expect(e1.runMutation("@email/lib:maintain", {}).value).toEqual({ filled: 200, more: false });
    expect(e1.runMutation("@email/lib:maintain", {}).value).toEqual({ filled: 0, more: false });
    const unread = e1.runQuery("@email/lib:threads", { mailbox: "support", unread: true, paginationOpts: { numItems: 5000, cursor: null } }).value as any;
    expect(unread.page).toHaveLength(800);
    const c = e1.runQuery("@email/lib:counts", { mailbox: "support" }).value as any;
    expect(c.all).toEqual({ threads: 1200, unread: 1200, unreadThreads: 800 });
    expect(c.byStatus.open).toEqual(c.all);
  });
});

describe("blind copies", () => {
  test("reply and compose take bcc: delivered in the envelope only, never in a header or body; kept on the message", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({ messageId: "b1@user.test" });
    await h.tick();
    const before = h.sent.length;
    const r = h.mutate("@email/lib:reply", { threadId: t.threadId, text: "See you", cc: ["Dora <dora@user.test>"], bcc: ["Boss <boss@acme.test>"], author: "Bia" });
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["caio@user.test"], subject: "Hi", text: "Hello", bcc: ["audit@acme.test", "Boss <boss@acme.test>"] });
    await h.tick();
    const [reply, composed] = h.sent.slice(before);
    // Delivered: the transport gets them as Bcc (the envelope), not as To or Cc.
    expect(reply!.bcc).toEqual([{ email: "boss@acme.test", name: "Boss" }]);
    expect(composed!.bcc).toEqual([{ email: "audit@acme.test" }, { email: "boss@acme.test", name: "Boss" }]);
    for (const m of [reply!, composed!]) {
      const visible = JSON.stringify({ to: m.to, cc: m.cc, headers: m.headers, subject: m.subject, html: m.html, text: m.text, replyTo: m.replyTo });
      expect(visible).not.toMatch(/boss@acme\.test|audit@acme\.test/i);
      expect(Object.keys(m.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("bcc");
    }
    expect(reply!.cc).toEqual([{ email: "dora@user.test", name: "Dora" }]);
    // Stored on the thread's outbound message (the mailbox's own view), and on the email row.
    const msg = (id: string, threadId: string) => h.query("@email/lib:thread", { threadId }).messages.find((m: any) => m._id === id);
    expect(msg(r.messageId, t.threadId).bcc).toEqual([{ email: "boss@acme.test", name: "Boss" }]);
    expect(msg(c.messageId, c.threadId).bcc).toEqual([{ email: "audit@acme.test" }, { email: "boss@acme.test", name: "Boss" }]);
    expect(h.get(r.emailId).bcc).toEqual([{ email: "boss@acme.test", name: "Boss" }]);
    // The next reply's quote and headers never carry them either.
    expect(msg(r.messageId, t.threadId).searchText).not.toMatch(/boss@acme/);
    // Same validation and limits as cc.
    expect(() => h.mutate("@email/lib:reply", { threadId: t.threadId, text: "x", bcc: ["not an address"] })).toThrow();
    expect(() => h.mutate("@email/lib:compose", { mailbox: "support", to: ["a@user.test"], subject: "s", text: "x", bcc: Array.from({ length: 50 }, (_, i) => `b${i}@user.test`) })).toThrow(/at most 50 recipients/);
    // A blind-copied person answering joins the thread (they got the Message-ID).
    const mid = h.get(c.emailId).messageId.toLowerCase();
    expect(h.ingest({ from: { email: "audit@acme.test" }, subject: "fyi", inReplyTo: mid }).threadId).toBe(c.threadId);
    // ...but the next reply to the contact never quotes or cites the blind-copied person's answer.
    const sentBefore = h.sent.length;
    h.mutate("@email/lib:reply", { threadId: c.threadId, text: "Follow-up" });
    await h.tick();
    const follow = h.sent[sentBefore]!;
    expect(JSON.stringify({ html: follow.html, text: follow.text, headers: follow.headers })).not.toMatch(/audit@acme\.test|fyi/i);
    // The thread remembers who was only blind-copied, however long ago; copying them visibly later clears that.
    const blindOf = (id: string) => h.query("@email/lib:thread", { threadId: id }).thread.blind;
    expect(blindOf(c.threadId)).toEqual(["audit@acme.test", "boss@acme.test"]);
    h.mutate("@email/lib:reply", { threadId: c.threadId, text: "Looping you in", cc: ["audit@acme.test"] });
    expect(blindOf(c.threadId)).toEqual(["boss@acme.test"]);
  });

  test("a deleted thread has no timeline; a reply suppressed at send time is on the timeline", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({});
    h.mutate("@email/lib:setStatus", { threadId: t.threadId, status: "closed" });
    expect(h.query("@email/lib:activity", { threadId: t.threadId }).length).toBeGreaterThan(0);
    h.mutate("@email/lib:deleteThread", { threadId: t.threadId });
    expect(h.query("@email/lib:activity", { threadId: t.threadId })).toEqual([]);

    const u = h.ingest({ from: { email: "gone@user.test" }, envelopeFrom: "gone@user.test" });
    h.mutate("@email/lib:suppress", { project: "mailbox:support", email: "gone@user.test" });
    const r = h.mutate("@email/lib:reply", { threadId: u.threadId, text: "Hi" });
    expect(r.status).toBe("suppressed");
    expect(h.query("@email/lib:activity", { threadId: u.threadId }).at(-1)).toMatchObject({ kind: "delivery", data: { emailId: r.emailId, status: "suppressed", previous: "queued", messageId: r.messageId } });
  });
});
