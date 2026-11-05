import { describe, expect, it } from "vitest";
import { parseRestoreTarget, PITR_RETENTION_MS, resolveBookmark, resolveDeployPoint, restoreCommand, type BookmarkRow } from "../src/restore.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const H = 3_600_000;
const bm = (n: number) => `00000000-${n.toString(16).padStart(8, "0")}-00005119-${"ab".repeat(16)}`;
const rows: BookmarkRow[] = [
  { id: 1, at: NOW - 40 * 24 * H, bookmark: bm(1), reason: "migrate" },
  { id: 2, at: NOW - 10 * H, bookmark: bm(2), reason: "deploy:aaaa1111-0000" },
  { id: 3, at: NOW - 9 * H, bookmark: bm(3), reason: "hourly" },
  { id: 4, at: NOW - 3 * H, bookmark: bm(4), reason: "deploy:bbbb2222-0000" },
  { id: 5, at: NOW - 2 * H, bookmark: bm(5), reason: "hourly" },
];

describe("restore targets", () => {
  it("parses bookmarks, deploys, ISO, epoch and relative times", () => {
    expect(parseRestoreTarget(bm(9), NOW)).toEqual({ kind: "bookmark", bookmark: bm(9) });
    expect(parseRestoreTarget("deploy:AAAA1111", NOW)).toEqual({ kind: "deploy", version: "aaaa1111" });
    expect(parseRestoreTarget("-90m", NOW)).toEqual({ kind: "time", at: NOW - 90 * 60_000 });
    expect(parseRestoreTarget("-1d", NOW)).toEqual({ kind: "time", at: NOW - 24 * H });
    expect(parseRestoreTarget("2026-11-05T10:00:00Z", NOW)).toEqual({ kind: "time", at: NOW - 2 * H });
    expect(parseRestoreTarget(String(NOW - 5), NOW)).toEqual({ kind: "time", at: NOW - 5 });
    expect(() => parseRestoreTarget("yesterday", NOW)).toThrow(/cannot parse/);
    expect(() => parseRestoreTarget("deploy:x", NOW)).toThrow(/invalid deploy/);
  });

  it("time → newest recorded bookmark at or before it; refuses the future and the 30-day edge", () => {
    expect(resolveBookmark(rows, { kind: "time", at: NOW - 2.5 * H }, NOW)).toMatchObject({ ok: true, bookmark: bm(4), exact: false });
    expect(resolveBookmark(rows, { kind: "time", at: NOW - 2 * H }, NOW)).toMatchObject({ ok: true, bookmark: bm(5), exact: true });
    expect(resolveBookmark(rows, { kind: "time", at: NOW + 1 }, NOW)).toMatchObject({ ok: false, code: "not_found" });
    expect(resolveBookmark(rows, { kind: "time", at: NOW - 31 * 24 * H }, NOW)).toMatchObject({ ok: false, code: "expired" });
    // Inside the window, but the only older bookmark is outside it.
    expect(resolveBookmark(rows, { kind: "time", at: NOW - 20 * 24 * H }, NOW)).toMatchObject({ ok: false, code: "expired" });
    expect(resolveBookmark(rows, { kind: "bookmark", bookmark: bm(1) }, NOW)).toMatchObject({ ok: false, code: "expired" });
    expect(resolveBookmark(rows, { kind: "bookmark", bookmark: bm(42) }, NOW)).toMatchObject({ ok: true, at: null });
  });

  it("deploy → that version's boot bookmark, refusing ambiguous prefixes", () => {
    expect(resolveBookmark(rows, { kind: "deploy", version: "bbbb" }, NOW)).toMatchObject({ ok: true, bookmark: bm(4), reason: "deploy:bbbb2222-0000" });
    const amb = [...rows, { id: 6, at: NOW - H, bookmark: bm(6), reason: "deploy:bbbb9999" }];
    expect(resolveBookmark(amb, { kind: "deploy", version: "bbbb" }, NOW)).toMatchObject({ ok: false, code: "ambiguous" });
    expect(resolveBookmark(rows, { kind: "deploy", version: "cccc" }, NOW)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("all shards to a deploy point: own bookmark, else the first boot after it, else already there", () => {
    // The shard never booted under cccc (deployed 5 h ago): its first boot after = deploy:bbbb (3 h ago).
    expect(resolveDeployPoint(rows, "cccc", NOW - 5 * H, NOW)).toMatchObject({ ok: true, bookmark: bm(4), exact: false });
    expect(resolveDeployPoint(rows, "cccc", NOW - H, NOW)).toMatchObject({ ok: true, skip: true });
    expect(resolveDeployPoint(rows, "aaaa", null, NOW)).toMatchObject({ ok: true, bookmark: bm(2) });
    expect(resolveDeployPoint(rows, "cccc", null, NOW)).toMatchObject({ ok: false, code: "not_found" });
    expect(PITR_RETENTION_MS).toBe(30 * 24 * H);
  });
});

function fakeAdmin(shards: Record<string, BookmarkRow[]>) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: u.pathname, ...(body ? { body } : {}) });
    if ((init?.headers as Record<string, string>).authorization !== "Bearer adm") return new Response(JSON.stringify({ ok: false, error: { code: "unauthenticated", message: "x" } }), { status: 401 });
    if (u.pathname === "/api/_ember/bookmarks") return Response.json({ ok: true, bookmarks: shards[u.searchParams.get("shard")!] ?? [], now: NOW });
    if (u.pathname === "/api/_ember/restore") return Response.json({ ok: true, shard: body.shard, restoredTo: body.bookmark, undo: `00000001-ffffffff-00005119-${"cd".repeat(16)}`, version: 3, epoch: "e2", schemaVersion: "abc" });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("restoreCommand", () => {
  it("lists, confirms, restores one shard and prints the undo bookmark", async () => {
    const { calls, fetchImpl } = fakeAdmin({ "chat:a": rows });
    const lines: string[] = [];
    const base = { url: "https://x.example", adminToken: "adm", fetch: fetchImpl, now: () => NOW, log: (l: string) => lines.push(l) };
    await restoreCommand({ ...base, shard: "chat:a", list: true });
    expect(lines.join("\n")).toMatch(/5 bookmark\(s\)[\s\S]*migrate.*\(expired\)[\s\S]*deploy:bbbb2222-0000/);

    lines.length = 0;
    let asked = "";
    const none = await restoreCommand({ ...base, shard: "chat:a", to: "-150m", confirm: async (q) => ((asked = q), false) });
    expect(none).toEqual([]);
    expect(asked).toBe("Restore chat:a?");
    expect(calls.filter((c) => c.path === "/api/_ember/restore")).toHaveLength(0);

    lines.length = 0;
    const done = await restoreCommand({ ...base, shard: "chat:a", to: "deploy:bbbb", yes: true });
    expect(done[0]!.undo).toMatch(/^00000001-ffffffff/);
    expect(calls.find((c) => c.path === "/api/_ember/restore")?.body).toEqual({ shard: "chat:a", bookmark: bm(4) });
    expect(lines.join("\n")).toContain(`undo: ember restore --shard chat:a --to 00000001-ffffffff-00005119-${"cd".repeat(16)} --yes`);
  });

  it("--all restores every catalog shard to a deploy point and refuses when one cannot", async () => {
    const other: BookmarkRow[] = [{ id: 1, at: NOW - H, bookmark: bm(7), reason: "deploy:dddd" }];
    const quiet: BookmarkRow[] = [{ id: 1, at: NOW - 20 * H, bookmark: bm(8), reason: "deploy:0000" }];
    const { calls, fetchImpl } = fakeAdmin({ "chat:a": rows, "chat:b": other, "chat:c": quiet });
    const lines: string[] = [];
    const base = { url: "https://x.example", adminToken: "adm", fetch: fetchImpl, now: () => NOW, log: (l: string) => lines.push(l), yes: true };
    const done = await restoreCommand({ ...base, all: true, to: "deploy:bbbb", catalog: async () => ["chat:a", "chat:b", "chat:c"], deployTime: async () => NOW - 3 * H });
    expect(done.map((d) => d.shard).sort()).toEqual(["chat:a", "chat:b"]);
    const restored = calls.filter((c) => c.path === "/api/_ember/restore").map((c) => [c.body.shard, c.body.bookmark]);
    expect(restored.sort()).toEqual([["chat:a", bm(4)], ["chat:b", bm(7)]]);
    expect(lines.join("\n")).toMatch(/chat:c\s+skip: no boot since that deploy/);

    // A shard whose only bookmarks are too old blocks the whole plan before anything changes.
    const { calls: c2, fetchImpl: f2 } = fakeAdmin({ "chat:a": rows, "chat:z": [] });
    await expect(restoreCommand({ ...base, fetch: f2, all: true, to: "-1h", catalog: async () => ["chat:a", "chat:z"] })).rejects.toThrow(/cannot be restored/);
    expect(c2.filter((c) => c.path === "/api/_ember/restore")).toHaveLength(0);
  });
});
