// `ember files orphans` against a fake runtime: pages through the cursor, dry run by default, --delete, skipped
// shards, an old runtime (404), and the credential URL rule.
import { describe, expect, it } from "vitest";
import { DEFAULT_GRACE_MS, filesOrphans, parseDuration } from "../src/files.ts";

const orphan = (key: string, size = 10) => ({ key, shard: "org:a", size, uploaded: Date.UTC(2026, 0, 1) });

function fakeRuntime(pages: Array<Record<string, unknown>>, status = 200) {
  const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body });
    if (status !== 200) return new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "no" } }), { status });
    const i = body.cursor ? Number(body.cursor) : 0;
    const p = { scanned: 2, foreign: 0, young: 0, orphans: [], deleted: 0, skipped: [], graceMs: body.graceMs, ...pages[i], cursor: i + 1 < pages.length ? String(i + 1) : null, done: i + 1 >= pages.length };
    return new Response(JSON.stringify({ ok: true, value: p }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("ember files orphans", () => {
  it("pages through the bucket with the cursor, a dry run by default, and sums up", async () => {
    const { f, calls } = fakeRuntime([{ orphans: [orphan("f/a/1")], foreign: 1 }, { orphans: [orphan("f/a/2", 5)], young: 1 }, {}]);
    const lines: string[] = [];
    const sum = await filesOrphans({ url: "https://app.example.com", adminToken: "tok", fetch: f, log: (l) => lines.push(l) });
    expect(calls.map((c) => [c.url, c.auth, c.body])).toEqual([
      ["https://app.example.com/api/_ember/files/orphans", "Bearer tok", { graceMs: DEFAULT_GRACE_MS, delete: false }],
      ["https://app.example.com/api/_ember/files/orphans", "Bearer tok", { graceMs: DEFAULT_GRACE_MS, delete: false, cursor: "1" }],
      ["https://app.example.com/api/_ember/files/orphans", "Bearer tok", { graceMs: DEFAULT_GRACE_MS, delete: false, cursor: "2" }],
    ]);
    expect(sum).toMatchObject({ scanned: 6, orphans: 2, bytes: 15, foreign: 1, young: 1, deleted: 0, dryRun: true });
    expect(lines.filter((l) => l.startsWith("orphan "))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/2 orphan\(s\), 15 bytes \(dry run: pass --delete/);
  });

  it("--delete, --grace, --limit and --json; skipped shards are reported", async () => {
    const skipped = { shard: "org:b", keys: 3, code: "MigrationRefused", message: "refused" };
    const { f, calls } = fakeRuntime([{ orphans: [orphan("f/a/1")], deleted: 1, skipped: [skipped] }]);
    const lines: string[] = [];
    const sum = await filesOrphans({ url: "http://localhost:8787", adminToken: "t", graceMs: 3_600_000, limit: 100, delete: true, json: true, fetch: f, log: (l) => lines.push(l) });
    expect(calls[0]!.body).toEqual({ graceMs: 3_600_000, delete: true, limit: 100 });
    expect(sum).toMatchObject({ deleted: 1, dryRun: false, skipped: [skipped] });
    expect(lines.map((l) => Object.keys(JSON.parse(l))[0])).toEqual(["orphan", "summary"]);
  });

  it("an old runtime (404) says so; plain http off loopback is refused before any request", async () => {
    const old = fakeRuntime([], 404);
    await expect(filesOrphans({ url: "https://x.example.com", adminToken: "t", fetch: old.f, log: () => {} })).rejects.toThrow(/admin API level 12/);
    const none = fakeRuntime([{}]);
    await expect(filesOrphans({ url: "http://x.example.com", adminToken: "t", fetch: none.f, log: () => {} })).rejects.toThrow();
    expect(none.calls).toEqual([]);
  });

  it("parseDuration", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("0")).toBe(0);
    expect(() => parseDuration("-1h")).toThrow(/duration/);
    expect(() => parseDuration("soon")).toThrow(/duration/);
  });
});
