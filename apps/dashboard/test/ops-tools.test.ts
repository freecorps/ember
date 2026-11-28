// The SPA's pure helpers for PR 6a-3b: the Function Runner's history and its cURL / TypeScript copies (runner.ts),
// and the logs search and NDJSON export (logsearch.ts).
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { clearHistory, curlFor, forgetHistory, HISTORY_KEY, historyEpoch, HISTORY_MAX, loadHistory, refFor, RESULT_MAX, saveRun, shellQuote, tsFor, tsLiteral } from "../src/app/runner.ts";
import { EXPORT_MAX, searchLogs, toNdjson, type LogRecord } from "../src/app/logsearch.ts";
import { fileName } from "../src/app/export.ts";
import { sameRoute } from "../src/app/hooks.ts";

const g = globalThis as { localStorage?: unknown };
afterEach(() => {
  forgetHistory(); // the module's in-memory fallback, between tests
  delete g.localStorage;
});
function memoryStorage() {
  const m = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  return m;
}

describe("run history (localStorage)", () => {
  const run = (i: number) => ({ at: 1_000 + i, project: "chat", env: "prod", fn: "messages:send", type: "mutation" as const, shard: "org:acme", args: { i }, ok: true, result: { id: `m${i}` }, ms: 1.5 });

  it("keeps the newest HISTORY_MAX runs, newest first, results cut at RESULT_MAX", () => {
    const m = memoryStorage();
    let list = loadHistory();
    expect(list).toEqual([]);
    for (let i = 0; i < HISTORY_MAX + 5; i++) list = saveRun(list, run(i));
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0]!.args).toEqual({ i: HISTORY_MAX + 4 });
    expect(loadHistory().map((e) => e.id)).toEqual(list.map((e) => e.id));
    const big = saveRun(list, { ...run(99), ok: false, result: { message: "x".repeat(RESULT_MAX * 2) } });
    expect(big[0]!.result.length).toBe(RESULT_MAX + 1);
    expect(m.get(HISTORY_KEY)).not.toContain("token");
  });

  it("each write starts from the stored history (two tabs), and signing out forgets it", () => {
    const m = memoryStorage();
    // Both tabs loaded an empty history; each saves a run from its own (stale) copy.
    const tabA = saveRun([], run(1));
    const tabB = saveRun([], run(2));
    expect(tabB.map((e) => e.args)).toEqual([{ i: 2 }, { i: 1 }]);
    expect(loadHistory()).toHaveLength(2);
    // Tab A clears the function with a copy that misses B's run: B's run (same function) goes too, nothing comes back.
    expect(clearHistory(tabA, { project: "chat", env: "prod", fn: "messages:send" })).toEqual([]);
    saveRun([], { ...run(3), fn: "rooms:list" });
    expect(clearHistory(tabA, { project: "chat", env: "prod", fn: "messages:send" }).map((e) => e.fn)).toEqual(["rooms:list"]);
    forgetHistory();
    expect(m.has(HISTORY_KEY)).toBe(false);
  });

  it("works without storage (throws, or garbage in it)", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(loadHistory()).toEqual([]);
    expect(saveRun([], run(1))).toHaveLength(1);
    const m = memoryStorage();
    m.set(HISTORY_KEY, "{not json");
    expect(loadHistory()).toEqual([]);
    m.set(HISTORY_KEY, JSON.stringify([{ id: 1 }, null, "x"]));
    expect(loadHistory()).toEqual([]);
  });

  it("storage that reads but refuses writes: runs pile up in memory (the second does not drop the first)", () => {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: (k: string) => void m.delete(k),
    };
    saveRun([], run(1));
    expect(saveRun([], run(2)).map((e) => e.args)).toEqual([{ i: 2 }, { i: 1 }]);
    // Once writes work again, the stored history is the base again (another tab's runs kept).
    const ok = memoryStorage();
    saveRun([], run(3));
    ok.set(HISTORY_KEY, JSON.stringify([...JSON.parse(ok.get(HISTORY_KEY)!), { ...run(9), id: "other-tab", result: "{}" }]));
    expect(saveRun([], run(4)).map((e) => e.id).includes("other-tab")).toBe(true);
  });

  it("signing out moves the epoch: a run answered after it (started before) is not recorded by the page", () => {
    const before = historyEpoch();
    forgetHistory();
    expect(historyEpoch()).toBe(before + 1);
  });
});

describe("copy as cURL", () => {
  it("is the admin run call with the token as a placeholder, and quotes the body for the shell", () => {
    const args = { body: `it's "quoted" $HOME \`id\` \\ ok`, n: 1 };
    const text = curlFor({ url: "https://p.example/", shard: "org:acme", fn: "messages:send", args, as: { subject: "user_1" } });
    expect(text).toContain(`'https://p.example/api/_ember/run'`);
    expect(text).toContain(`-H "Authorization: Bearer $EMBER_ADMIN_TOKEN"`);
    expect(text).not.toMatch(/Bearer (?!\$EMBER_ADMIN_TOKEN)/);
    expect(curlFor({ url: null, shard: "global:main", fn: "a:b", args: {} })).toContain(`"$EMBER_URL/api/_ember/run"`);
    // The shell gives back exactly the JSON body (no expansion of $, backticks, backslashes).
    const data = text.split("--data-raw ")[1]!;
    const echoed = execFileSync("/bin/sh", ["-c", `printf %s ${data}`]).toString();
    expect(JSON.parse(echoed)).toEqual({ shard: "org:acme", fn: "messages:send", args, as: { subject: "user_1" } });
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("copy as TypeScript", () => {
  it("names the function like the generated api (nested modules, internal, components by name)", () => {
    expect(refFor("messages:send", "public")).toBe("api.messages.send");
    expect(refFor("admin/users:list", "internal")).toBe("internal.admin.users.list");
    expect(refFor("my-mod:fn", "public")).toBe(`api["my-mod"].fn`);
    expect(refFor("@pool/lib:stats", "public")).toBe(`unsafeRef("@pool/lib:stats")`);
  });

  it("writes the args as a TS literal (keys unquoted when they can be, strings JSON-quoted)", () => {
    expect(tsLiteral({ a: 1, "b-c": "it's \"x\"\n", nested: { list: [true, null] }, empty: {} })).toBe(
      `{\n  a: 1,\n  "b-c": "it's \\"x\\"\\n",\n  nested: {\n    list: [\n      true,\n      null,\n    ],\n  },\n  empty: {},\n}`,
    );
    // `__proto__` stays an own key (a plain `__proto__:` would set the prototype).
    const proto = tsLiteral(JSON.parse(`{"payload":{"__proto__":{"x":1}}}`));
    expect(proto).toContain(`["__proto__"]: {`);
    expect(new Function(`return ${proto}`)()).toEqual(JSON.parse(`{"payload":{"__proto__":{"x":1}}}`));
    const pub = tsFor({ fn: "messages:send", type: "mutation", visibility: "public", args: { channel: "general" } });
    expect(pub).toContain(`await client.mutation(api.messages.send, {\n  channel: "general",\n});`);
    expect(pub).toContain(`await ctx.runMutation(api.messages.send, {`);
    const internal = tsFor({ fn: "messages:secret", type: "query", visibility: "internal", args: {} });
    expect(internal).not.toContain("client.");
    expect(internal).toContain("await ctx.runQuery(internal.messages.secret, {});");
  });
});

describe("logs search and NDJSON export", () => {
  const now = Date.now();
  const rec = (n: number, o: Partial<LogRecord> = {}): LogRecord & { n: number } => ({ n, t: now - n * 60_000, outcome: "ok", head: "POST /api/mutation", lines: [], ...o });
  const records = [
    rec(30, { lines: [{ t: now, kind: "log", level: "log", message: "boot ok" }] }),
    rec(10, { lines: [{ t: now, kind: "log", level: "warn", message: "Slow query on rooms" }] }),
    rec(2, { lines: [{ t: now, kind: "exec", fn: "messages:send", shard: "org:acme", type: "mutation", status: "error", errorCode: "Boom", ms: 3, rowsRead: 1, rowsWritten: 0 }] }),
    rec(1, { outcome: "exception", lines: [{ t: now, kind: "exception", message: "TypeError: x is undefined" }] }),
  ];
  const q = (o: Partial<Parameters<typeof searchLogs>[1]> = {}) => searchLogs(records, { text: "", level: "any", fn: "", since: 0, ...o }).map((r) => r.n);

  it("filters by text (case-insensitive), level, function and time range", () => {
    expect(q()).toEqual([30, 10, 2, 1]);
    expect(q({ text: "SLOW" })).toEqual([10]);
    expect(q({ text: "boom" })).toEqual([2]);
    expect(q({ level: "warn" })).toEqual([10, 2, 1]);
    expect(q({ level: "error" })).toEqual([2, 1]);
    expect(q({ fn: "messages:" })).toEqual([2]);
    // The function filter ignores case too, and matches only the executions' functions (never the request line).
    expect(q({ fn: "Messages:SEND" })).toEqual([2]);
    expect(q({ fn: "mutation" })).toEqual([]);
    expect(q({ text: "mutation" })).toEqual([30, 10, 2, 1]);
    expect(q({ since: now - 5 * 60_000 })).toEqual([2, 1]);
    expect(q({ since: now - 5 * 60_000, level: "error", text: "typeerror" })).toEqual([1]);
  });

  it("names the download from safe parts only (no path separators, no leading dot)", () => {
    expect(fileName("logs", "chat", "prod", "2026-11-26T14-00-00-000Z")).toBe("logs-chat-prod-2026-11-26T14-00-00-000Z");
    expect(fileName("logs", "../a/b", "c\\d e")).toBe("logs-__a_b-c_d_e");
    expect(fileName("..x")).toBe("_x");
  });

  it("exports one JSON object per line, capped at EXPORT_MAX lines", () => {
    const text = toNdjson(records);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]!)).toMatchObject({ outcome: "exception", head: "POST /api/mutation", time: new Date(records[3]!.t).toISOString() });
    expect(toNdjson([])).toBe("");
    const many = Array.from({ length: EXPORT_MAX + 10 }, (_, i) => rec(i));
    const big = toNdjson(many);
    expect(big.trimEnd().split("\n")).toHaveLength(EXPORT_MAX);
    expect(big.endsWith("}\n")).toBe(true);
    expect(big.endsWith("\n\n")).toBe(false);
  });
});

describe("same-route navigation (⌘K on the page shown)", () => {
  it("compares the parsed routes field by field (encoding, a trailing slash and the default section aside)", () => {
    expect(sameRoute("", "#/")).toBe(true);
    expect(sameRoute("#/p/chat/prod/data/org%3Aacme", "#/p/chat/prod/data/org:acme/")).toBe(true);
    expect(sameRoute("#/p/chat/prod", "#/p/chat/prod/health")).toBe(true);
    expect(sameRoute("#/p/chat/prod/data/org:acme", "#/p/chat/prod/data/org:beta")).toBe(false);
    expect(sameRoute("#/p/chat/prod/functions/a:b", "#/p/chat/prod/users/a:b")).toBe(false);
    expect(sameRoute("#/p/chat/prod/screens/x/@pool", "#/p/chat/prod/screens/x/@pool/jobs")).toBe(false);
    expect(sameRoute("#/audit", "#/")).toBe(false);
  });
});
