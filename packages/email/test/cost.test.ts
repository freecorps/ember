// Rows read and written, calls and jobs of the email component's hot paths (PR 2D), on the real engine. The budgets
// are the node:sqlite usage (rows returned / changed) measured after the change; the comments give the numbers before.
import type { InboundEmailMessage } from "@freecorps/ember-server";
import { describe, expect, test } from "vitest";
import { email } from "../src/index.ts";
import { inboxHarness } from "./harness.ts";

type H = ReturnType<typeof inboxHarness>;
const noLimit = { rateLimit: { rate: 1_000_000, period: 60_000 }, spamPerHour: 1000 };

/** Drives the component's email() hook with a raw message; `ctx` parts replace the harness's (storage, env). */
async function deliverRaw(h: H, o: { from: string; to?: string; attachments?: Array<{ name: string; type: string; body: string }> }, over: Record<string, unknown> = {}) {
  const boundary = "b0undary";
  const head = [`Authentication-Results: mx.cloudflare.net; dkim=pass; dmarc=pass header.from=x; spf=pass`, `From: ${o.from}`, `To: ${o.to ?? "support@acme.test"}`, `Subject: Hello`, `Message-ID: <${Math.random()}@x.test>`];
  const raw = o.attachments?.length
    ? [
        ...head,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body",
        ...o.attachments.flatMap((a) => [`--${boundary}`, `Content-Type: ${a.type}; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, "", a.body]),
        `--${boundary}--`,
        "",
      ].join("\r\n")
    : [...head, "Content-Type: text/plain; charset=utf-8", "", "Body", ""].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  // Typed against the hook's contract: a change to InboundEmailMessage or to the hook's signature fails typecheck here.
  const msg = {
    from: o.from,
    to: o.to ?? "support@acme.test",
    headers: new Headers(),
    raw: new Response(bytes).body!,
    rawSize: bytes.length,
    setReject: (r: string) => void (rejected = r),
    forward: async () => ({}),
    reply: async () => ({}),
  } satisfies InboundEmailMessage;
  const hook = email.email;
  if (!hook) throw new Error("the email component has no email() hook");
  await hook.handler({ ...h.ctxFor("@email/lib:send"), ...over }, msg);
  return rejected as string | null;
}

/** A storage stand-in that counts calls in flight (each call waits a little). */
function slowStorage(h: H) {
  const probe = { inFlight: 0, max: 0, stored: 0 };
  const wait = async () => {
    probe.inFlight++;
    probe.max = Math.max(probe.max, probe.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    probe.inFlight--;
  };
  return {
    probe,
    storage: {
      store: async (bytes: Uint8Array, o: { contentType: string }) => {
        await wait();
        probe.stored++;
        return h.storeFile(o.contentType, bytes.length || 1);
      },
      get: async (file: string) => {
        await wait();
        return { body: new Response(new TextEncoder().encode(`content of ${file}`)).body! };
      },
    },
  };
}

describe("email: fewer rows per write", () => {
  test("a new inbound conversation is inserted once, with its first message counted", () => {
    const h = inboxHarness(noLimit);
    h.resetCounters();
    const r = h.ingest({ messageId: "c1@user.test" });
    // before PR 2D: 18 rows written (thread insert, then a patch of counts and unread flag, the `unread` aggregate); now 10.
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(10);
    const t = h.query("@email/lib:thread", { threadId: r.threadId }).thread;
    expect(t).toMatchObject({ messageCount: 1, unreadCount: 1, hasUnread: true, status: "open", lastInboundAt: t.lastMessageAt });
    expect(h.query("@email/lib:counts", { mailbox: "support" }).all).toEqual({ threads: 1, unread: 1, unreadThreads: 1 });
    expect(h.query("@email/lib:unread", { mailboxes: ["support"] })).toEqual({ support: { unread: 1, threads: 1 } });
    // A second message to it still goes through the thread write (counts move).
    h.ingest({ messageId: "c2@user.test", inReplyTo: "c1@user.test", references: ["c1@user.test"] });
    expect(h.query("@email/lib:thread", { threadId: r.threadId }).thread).toMatchObject({ messageCount: 2, unreadCount: 2 });
  });

  test("compose inserts its thread once, blind copies included", () => {
    const h = inboxHarness();
    h.resetCounters();
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["caio@user.test"], subject: "Hi", text: "Hello", bcc: ["audit@acme.test"] });
    // before PR 2D: 11 rows written (thread insert, then a patch with the first message's counts); now 9.
    expect(h.counters.rowsWritten).toBeLessThanOrEqual(9);
    const t = h.query("@email/lib:thread", { threadId: c.threadId }).thread;
    expect(t).toMatchObject({ messageCount: 1, unreadCount: 0, hasUnread: false, status: "waiting", blind: ["audit@acme.test"] });
    expect(h.query("@email/lib:counts", { mailbox: "support" }).byStatus.waiting).toEqual({ threads: 1, unread: 0, unreadThreads: 0 });
  });

  test("deleting a tag untags its threads without resyncing their other tag rows", () => {
    const h = inboxHarness(noLimit);
    const tags = ["a", "b", "c"].map((name) => h.mutate("@email/lib:createTag", { mailbox: "support", name }) as string);
    const threads = Array.from({ length: 5 }, (_, i) => h.ingest({ messageId: `t${i}@user.test`, from: { email: `p${i}@user.test` } }).threadId);
    for (const t of threads) h.mutate("@email/lib:setTags", { threadId: t, tags });
    h.resetCounters();
    h.mutate("@email/lib:deleteTag", { tagId: tags[1] });
    // before PR 2D: 31 rows read (each thread's tag rows read back for a resync); now 16.
    expect(h.counters.rowsRead).toBeLessThanOrEqual(16);
    for (const t of threads) expect(h.query("@email/lib:thread", { threadId: t }).thread.tags).toEqual([tags[0], tags[2]]);
    const byTag = (tag: string) => h.query("@email/lib:threads", { mailbox: "support", tag, paginationOpts: { numItems: 50, cursor: null } }).page.length;
    expect([byTag(tags[0]!), byTag(tags[2]!)]).toEqual([5, 5]);
    expect(Object.keys(h.query("@email/lib:counts", { mailbox: "support" }).tags)).toEqual([tags[0], tags[2]]);
  });
});

describe("email: fewer calls and jobs", () => {
  test("the email() hook skips lib:screen when the mailbox has no sender rules", async () => {
    const h = inboxHarness(noLimit);
    expect(await deliverRaw(h, { from: "ana@user.test" })).toBeNull();
    expect(h.counters.calls["@email/lib:screen"]).toBeUndefined();
    expect(h.counters.calls["@email/lib:ingest"]).toBe(1);
    // A rule of another mailbox changes nothing here; one for this mailbox, or for every mailbox, screens again.
    h.mutate("@email/lib:setSenderRule", { pattern: "spam.test", action: "reject", mailbox: "privacy" });
    await deliverRaw(h, { from: "ana@user.test" });
    expect(h.counters.calls["@email/lib:screen"]).toBeUndefined();
    h.mutate("@email/lib:setSenderRule", { pattern: "spam.test", action: "reject", mailbox: null });
    expect(await deliverRaw(h, { from: "bob@spam.test" })).toBe("Message rejected");
    expect(h.counters.calls["@email/lib:screen"]).toBe(1);
    expect(await deliverRaw(h, { from: "bob@spam.test", to: "privacy@acme.test" })).toBe("Message rejected");
  });

  test("screen looks the rules of one address up once (From = Reply-To = envelope)", () => {
    const h = inboxHarness();
    h.mutate("@email/lib:setSenderRule", { pattern: "x.test", action: "spam" });
    const screen = (a: Record<string, unknown>) => {
      const r = h.engine.runMutation("@email/lib:screen", { mailbox: "support", dmarc: "pass", ...a });
      return { verdict: r.value as any, read: r.usage!.rowsRead };
    };
    const same = screen({ from: "ana@user.test", replyTo: "Ana@User.test", envelopeFrom: "ana@user.test" });
    const three = screen({ from: "ana@user.test", replyTo: "bia@user.test", envelopeFrom: "caio@user.test" });
    expect(same.verdict).toBeNull();
    expect(three.verdict).toBeNull();
    // node:sqlite counts rows returned: a miss reads none, so compare the lookups through a hit instead.
    const hit = screen({ from: "a@x.test", replyTo: "a@x.test", envelopeFrom: "a@x.test" });
    const hits = screen({ from: "a@x.test", replyTo: "b@x.test", envelopeFrom: "c@x.test" });
    expect(hit.verdict).toMatchObject({ action: "spam", sender: "from" });
    expect(hit.read).toBeLessThan(hits.read);
  });

  test("claim carries the stored template: delivery does not query it again", async () => {
    const h = inboxHarness();
    h.mutate("@email/lib:upsertTemplate", { name: "welcome", subject: "Welcome {{name}}", html: "<p>Hello {{name}}</p>" });
    h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", template: { name: "welcome", data: { name: "Ana" } } });
    h.resetCounters();
    await h.tick();
    expect(h.sent.at(-1)).toMatchObject({ subject: "Welcome Ana", html: expect.stringContaining("Hello Ana") });
    expect(h.counters.calls["@email/lib:templateFor"]).toBeUndefined();
    // Deleted while the email waited: the delivery fails as before.
    h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", template: { name: "welcome", data: {} }, sendAt: h.now() + 1000 });
    h.mutate("@email/lib:removeTemplate", { name: "welcome" });
    h.advance(1000);
    await h.tick();
    const list = h.query("@email/lib:list", {}).page;
    expect(list[0]).toMatchObject({ status: "failed", error: { code: "E_TEMPLATE" } });
  });

  test("claim with some recipients suppressed meanwhile writes the email once and sends to the rest", async () => {
    const h = inboxHarness();
    const r = h.mutate("@email/lib:send", { from: "x@acme.test", to: ["a@b.io", "c@d.io"], subject: "s", text: "t", sendAt: h.now() + 1000 });
    h.mutate("@email/lib:suppress", { email: "a@b.io" });
    h.advance(1000);
    await h.tick();
    expect(h.sent.at(-1)!.to).toEqual([{ email: "c@d.io" }]);
    expect(h.get(r.id)).toMatchObject({ status: "sent", to: [{ email: "c@d.io" }], suppressed: ["a@b.io"], attempts: 1 });
  });
});

describe("email: concurrent I/O in actions", () => {
  test("inbound: the raw message and the attachments are stored concurrently", async () => {
    const h = inboxHarness(noLimit);
    const { probe, storage } = slowStorage(h);
    const attachments = [1, 2, 3].map((i) => ({ name: `f${i}.txt`, type: "text/plain", body: `file ${i}` }));
    expect(await deliverRaw(h, { from: "ana@user.test", attachments }, { storage, env: { EMBER_FILES: {} } })).toBeNull();
    expect(probe.stored).toBe(4);
    expect(probe.max).toBe(4);
    const [t] = h.query("@email/lib:threads", { mailbox: "support", paginationOpts: { numItems: 5, cursor: null } }).page;
    const m = h.query("@email/lib:thread", { threadId: t._id }).messages[0];
    expect(m.raw).toEqual(expect.any(String));
    expect(m.attachments.map((a: any) => a.filename)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);
  });

  test("outbound: attachments are read concurrently and keep their order", async () => {
    const h = inboxHarness();
    const files = [1, 2, 3].map((i) => h.storeFile("text/plain", 10 + i));
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["eva@user.test"], subject: "Files", text: "Attached.", attachments: files.map((file, i) => ({ filename: `f${i}.txt`, contentType: "text/plain", file })) });
    const { probe, storage } = slowStorage(h);
    const job = h.jobs().find((j) => j.fn === "@email/lib:deliver")!;
    await h.runActionWith("@email/lib:deliver", job.args, { storage });
    expect(probe.max).toBe(3);
    const out = h.sent.at(-1)!;
    expect(out.attachments!.map((a) => a.filename)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(atob(out.attachments![2]!.content)).toBe(`content of ${files[2]}`);
    expect(h.get(c.emailId).status).toBe("sent");
  });
});

describe("email: Sent and presence", () => {
  test("Sent pages: no per-thread scan on the first page; later pages look past the cursor only", () => {
    const h = inboxHarness(noLimit);
    const threads = Array.from({ length: 12 }, (_, i) => h.ingest({ messageId: `q${i}@user.test`, from: { email: `p${i}@user.test` }, subject: `S${i}` }).threadId);
    // Each thread: 6 sends (with a note after each), then 8 answers from its contact after the last send.
    for (let k = 0; k < 6; k++) {
      for (const t of threads) {
        h.advance(1000);
        h.mutate("@email/lib:reply", { threadId: t, text: `r${k}` });
        h.mutate("@email/lib:note", { threadId: t, text: `n${k}` });
      }
    }
    for (let k = 0; k < 8; k++) {
      h.advance(1000);
      threads.forEach((t, i) => expect(h.ingest({ messageId: `a${k}-${i}@user.test`, from: { email: `p${i}@user.test` }, subject: `S${i}` }).threadId).toBe(t));
    }
    h.resetCounters();
    const first = h.query("@email/lib:sent", { mailbox: "support", limit: 5 });
    expect(first.page).toHaveLength(5);
    // before PR 2D: 96 rows read (each listed thread's messages from its send on, read again); now 46.
    expect(h.counters.rowsRead).toBeLessThanOrEqual(46);
    const seen = [...first.page.map((t: any) => t._id)];
    let next = first.next;
    while (next) {
      const p = h.query("@email/lib:sent", { mailbox: "support", limit: 5, before: next });
      seen.push(...p.page.map((t: any) => t._id));
      next = p.next;
    }
    expect([...seen].sort()).toEqual([...threads].sort());
    expect(new Set(seen).size).toBe(12);
  });

  test("presence: one sweep job per shard, however many rows; expired rows go in one run", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({}).threadId;
    const u = h.ingest({ messageId: "o@user.test", from: { email: "other@user.test" } }).threadId;
    h.resetCounters();
    for (let i = 0; i < 20; i++) h.mutate("@email/lib:setPresence", { threadId: i % 2 ? t : u, userId: `u${i}`, name: `U${i}`, state: "viewing" });
    // before PR 2D: 20 lib:expirePresence jobs; now one lib:sweepPresence.
    expect(h.counters.scheduled).toEqual({ "@email/lib:sweepPresence": 1 });
    // Heartbeats keep half of them; the others expire together.
    h.advance(20_000);
    for (let i = 0; i < 20; i += 2) h.mutate("@email/lib:setPresence", { threadId: u, userId: `u${i}`, name: `U${i}`, state: "viewing" });
    h.advance(10_000);
    await h.tick();
    expect(h.query("@email/lib:presence", { threadId: t })).toEqual([]);
    expect(h.query("@email/lib:presence", { threadId: u })).toHaveLength(10);
    expect(h.counters.calls["@email/lib:sweepPresence"]).toBe(1);
    h.advance(30_000);
    await h.tick();
    expect(h.query("@email/lib:presence", { threadId: u })).toEqual([]);
    expect(h.jobs().filter((j) => j.fn.includes("Presence"))).toEqual([]); // nothing left: no sweep armed
  });

  test("presence: a heartbeat that extends a row re-arms a sweep whose job is gone", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({}).threadId;
    const sweeps = () => h.jobs().filter((j) => j.fn === "@email/lib:sweepPresence");
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "a", name: "A", state: "viewing" });
    expect(sweeps().map((j) => j.runAt - h.now())).toEqual([30_000]);
    h.advance(20_000);
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "a", name: "A", state: "viewing" }); // expires at +50 s
    expect(sweeps().map((j) => j.runAt - h.now())).toEqual([10_000]); // the pending sweep covers it: not moved
    // The sweep's job fails for good at +30 s (attempts exhausted): it leaves the queue without running.
    h.advance(10_000);
    const jobs = h.jobs();
    jobs.splice(jobs.indexOf(sweeps()[0]!), 1);
    h.advance(5_000);
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "a", name: "A", state: "viewing" }); // expires at +65 s
    expect(sweeps().map((j) => j.runAt - h.now())).toEqual([30_000]);
    h.advance(30_000);
    await h.tick();
    expect(h.query("@email/lib:presence", { threadId: t })).toEqual([]);
    expect(sweeps()).toEqual([]);
  });

  test("presence: a shorter TTL brings the sweep sooner; a per-row job of an older version moves the row to the sweep", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({}).threadId;
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "a", name: "A", state: "viewing" });
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "b", name: "B", state: "viewing", ttlMs: 5_000 });
    expect(h.jobs().filter((j) => j.fn.includes("Presence")).map((j) => [j.fn, j.runAt - h.now()])).toEqual([["@email/lib:sweepPresence", 5_000]]);
    // An `expirePresence` job from before the upgrade: the row is not due, so it joins the sweep.
    expect(h.mutate("@email/lib:expirePresence", { threadId: t, userId: "a" })).toBeNull();
    h.advance(5_000);
    await h.tick();
    expect(h.query("@email/lib:presence", { threadId: t }).map((p: any) => p.userId)).toEqual(["a"]);
    h.advance(25_000);
    await h.tick();
    expect(h.query("@email/lib:presence", { threadId: t })).toEqual([]);
    // Due: the old job deletes it.
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "c", name: "C", state: "viewing" });
    h.advance(30_000);
    h.mutate("@email/lib:expirePresence", { threadId: t, userId: "c" });
    expect(h.query("@email/lib:presence", { threadId: t })).toEqual([]);
  });
});
