// The SQL builders: inputs can never reach the text unchecked (adversarial names), and the funnel / retention
// statements have the shape Analytics Engine SQL takes (one table, subquery in FROM, no JOIN), checked against a
// recorded SQL API answer.
import { afterEach, describe, expect, test } from "vitest";
import {
  cachedSql,
  checkBase,
  clearSqlCache,
  countsSql,
  funnelSql,
  deploymentOf,
  lit,
  NEVER_MS,
  overviewSql,
  parseFunnel,
  parseRetention,
  retentionSql,
  retentionStart,
  runSql,
  sqlCacheSize,
  SQL_API_BASE,
  SqlApiError,
  SqlInputError,
  topEventsSql,
  type CacheLike,
} from "../src/index.ts";

const scope = { dataset: "ember_analytics", install: "analytics" };
const ADVERSARIAL = [
  "x' OR '1'='1",
  "x\\' OR 1=1 --",
  "a'); DROP TABLE t; --",
  "a\nUNION SELECT blob2 FROM ember_metrics",
  "a`b",
  'a"b',
  "a;b",
  "a\u0000b",
  "/* c */",
  "' + (SELECT 1) + '",
  "",
  " ",
  "x".repeat(65),
];

/** Every string literal of a statement, and the text outside them. */
function literals(sql: string): { strings: string[]; outside: string } {
  const strings: string[] = [];
  let outside = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== "'") {
      outside += sql[i];
      continue;
    }
    let s = "";
    for (i++; i < sql.length && sql[i] !== "'"; i++) {
      if (sql[i] === "\\") i++;
      s += sql[i];
    }
    strings.push(s);
    outside += "''";
  }
  return { strings, outside };
}

describe("SQL inputs are checked, never interpolated raw", () => {
  test("adversarial event names are refused by every builder that takes names", () => {
    for (const bad of ADVERSARIAL) {
      expect(() => funnelSql(scope, { steps: ["signup", bad] })).toThrow(SqlInputError);
      expect(() => countsSql(scope, { names: [bad] })).toThrow(SqlInputError);
      expect(() => retentionSql(scope, { event: bad, now: 0 })).toThrow(SqlInputError);
    }
    expect(() => funnelSql(scope, { steps: ["a", 1 as unknown as string] })).toThrow(SqlInputError);
    expect(() => funnelSql(scope, { steps: "a,b" as unknown as string[] })).toThrow(SqlInputError);
  });

  test("dataset and install names are checked too", () => {
    for (const dataset of ["ember_metrics; DROP", "a-b", "a b", "", "x'y"]) expect(() => topEventsSql({ ...scope, dataset })).toThrow(/dataset/);
    for (const install of ["a'b", "a b", "/a", "a//b", ""]) expect(() => overviewSql({ ...scope, install })).toThrow(/install/);
    expect(overviewSql({ ...scope, install: "app/analytics" })).toContain("blob6 = 'app/analytics'");
  });

  test("numbers are clamped integers; a non-number is refused", () => {
    expect(countsSql(scope, { sinceHours: 1e9, now: 1e10 })).toContain(`double1 > ${1e10 - 2160 * 3600_000}`);
    expect(countsSql(scope, { sinceHours: -5, now: 1e10 })).toContain(`double1 > ${1e10 - 3600_000}`);
    expect(() => countsSql(scope, { now: "1; DROP" as unknown as number })).toThrow(SqlInputError);
    expect(() => funnelSql(scope, { steps: ["a", "b"], now: Number.NaN })).toThrow(SqlInputError);
    expect(topEventsSql(scope, { limit: 3.9 })).toContain("LIMIT 3");
    expect(() => topEventsSql(scope, { limit: "1; DROP" as unknown as number })).toThrow(SqlInputError);
    expect(() => funnelSql(scope, { steps: ["a", "b"], windowSeconds: Number.NaN })).toThrow(SqlInputError);
    expect(() => countsSql(scope, { bucket: "hour) --" as never })).toThrow(SqlInputError);
  });

  test("bucket and period are own keys: Object.prototype names are refused", () => {
    for (const bad of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(() => countsSql(scope, { bucket: bad as never })).toThrow(/minute, hour or day/);
      expect(() => retentionSql(scope, { period: bad as never, now: 0 })).toThrow(/day or week/);
      expect(() => retentionStart({ period: bad as never })).toThrow(/day or week/);
      expect(() => parseRetention({ data: [{ cohort: 0, users: 1 }] }, { period: bad as never, now: 0 })).toThrow(/day or week/);
    }
    expect(() => parseRetention({ data: [] }, { period: "month" as never, now: 0 })).toThrow(SqlInputError);
  });

  test("valid names end up only inside literals, and the literal escaping holds on its own", () => {
    const sql = funnelSql(scope, { steps: ["viewed pricing", "checkout:start", "paid/ok"] });
    const { strings, outside } = literals(sql);
    expect(strings).toEqual(expect.arrayContaining(["viewed pricing", "checkout:start", "paid/ok", "analytics"]));
    expect(outside).not.toMatch(/viewed|checkout|paid/);
    // The second wall: lit() of anything keeps it one literal.
    for (const bad of ADVERSARIAL) {
      const l = literals(`SELECT ${lit(bad)} AS x`);
      expect(l.strings).toEqual([bad]);
      expect(l.outside).toBe("SELECT '' AS x");
    }
  });

  test("steps: 2 to 8, distinct", () => {
    expect(() => funnelSql(scope, { steps: ["a"] })).toThrow(/2 to 8/);
    expect(() => funnelSql(scope, { steps: Array.from({ length: 9 }, (_, i) => `s${i}`) })).toThrow(/2 to 8/);
    expect(() => funnelSql(scope, { steps: ["a", "b", "a"] })).toThrow(/twice/);
    // A hole is refused (map would skip it, leaving an IN list with a gap and a step without its expression).
    const holey = new Array<string>(2);
    holey[0] = "view";
    expect(() => funnelSql(scope, { steps: holey })).toThrow(/steps\[1\]/);
    expect(() => countsSql(scope, { names: holey })).toThrow(/names\[1\]/);
  });

  test("deployments: staging and production sharing the account's default dataset read only their own rows", () => {
    const prod = deploymentOf({ EMBER_PROJECT: "shop", EMBER_ENV: "production" });
    const staging = deploymentOf({ EMBER_PROJECT: "shop", EMBER_ENV: "staging" });
    expect([prod, staging]).toEqual(["shop/production", "shop/staging"]);
    expect(deploymentOf({})).toBe("");
    expect(deploymentOf({ EMBER_PROJECT: "a'b c", EMBER_ENV: "x" })).toBe("a_b_c/x");
    for (const sql of [countsSql({ ...scope, deployment: prod }), overviewSql({ ...scope, deployment: prod }), funnelSql({ ...scope, deployment: prod }, { steps: ["a", "b"] }), retentionSql({ ...scope, deployment: prod }, { now: 0 })]) {
      expect(sql).toContain("blob6 = 'shop/production:analytics'");
      expect(sql).not.toContain("staging");
    }
    expect(countsSql({ ...scope, deployment: staging })).toContain("blob6 = 'shop/staging:analytics'");
    expect(() => countsSql({ ...scope, deployment: "x' OR 1=1" })).toThrow(/deployment/);
  });
});

describe("statement shapes", () => {
  test("event time, not arrival time: double1 (the batch's ts) orders funnels, buckets counts, places cohorts", () => {
    // A batch sent late (offline, beacons) arrives with one `timestamp` for every event: only double1 keeps the order.
    for (const sql of [funnelSql(scope, { steps: ["a", "b"] }), retentionSql(scope, { now: 0 }), countsSql(scope), topEventsSql(scope), overviewSql(scope)]) {
      expect(sql).toContain("double1 <= ");
      expect(sql).not.toMatch(/toUnixTimestamp\(timestamp\) -|toStartOfInterval\(timestamp|if\(blob1 = [^,]+, toUnixTimestamp\(timestamp\)/);
    }
    // The day's bounds are in the text (a cached answer of yesterday never serves today): the arrival range starts the
    // 1 h an event may be ahead of its arrival earlier, and an event of tomorrow is not counted today.
    const day = Date.UTC(2026, 10, 26) / 1000;
    expect(overviewSql(scope, { now: Date.UTC(2026, 10, 26, 23, 30) })).toContain(
      `toUnixTimestamp(timestamp) >= ${day - 3600} AND double1 >= ${day * 1000} AND double1 < ${(day + 86400) * 1000} AND double1 <= ${(day + 84600) * 1000}`,
    );
    expect(overviewSql(scope, { now: Date.UTC(2026, 10, 27, 0, 0, 10) })).toContain(`double1 >= ${(day + 86400) * 1000} AND`);
    expect(overviewSql(scope)).not.toContain("NOW()");
  });

  test("rolling reports end at now: an event up to 1 h ahead of its arrival is not counted before its time", () => {
    // Ingestion takes a `ts` up to 1 h ahead: without the upper bound a query at 10:01 counts an event of 10:40 (a
    // future bucket, a funnel step done before its time). The bound is the action's now in the text, never NOW().
    const now = Date.UTC(2026, 10, 26, 10, 1);
    const end = now / 1000;
    for (const sql of [countsSql(scope, { now }), topEventsSql(scope, { now }), funnelSql(scope, { steps: ["a", "b"], now }), retentionSql(scope, { now }), overviewSql(scope, { now })]) {
      // In ms (`double1`), not ET's whole seconds: an event at 10:01:00.001 is after a cutoff of 10:01:00.000.
      expect(sql).toContain(`double1 <= ${now}`);
      expect(sql).not.toContain(`${ET} <=`);
      expect(sql).not.toContain("NOW()");
    }
    // A cutoff with milliseconds keeps them (no rounding to whole seconds).
    expect(countsSql(scope, { now: now + 500 })).toContain(`double1 <= ${now + 500}`);
    // The arrival range still starts the full skew earlier (pruning never drops a valid event).
    expect(topEventsSql(scope, { sinceHours: 24, now })).toContain(`toUnixTimestamp(timestamp) >= ${end - 25 * 3600} AND double1 > ${now - 86400_000} AND`);
    // Inclusive: an event 1 h ahead of its arrival can be written in exactly the first second of the arrival range.
    expect(topEventsSql(scope, { sinceHours: 24, now })).not.toContain("toUnixTimestamp(timestamp) > ");
  });

  test("users: a signed-in subject and an anonymous id with the same text are two users", () => {
    for (const sql of [topEventsSql(scope), overviewSql(scope), funnelSql(scope, { steps: ["a", "b"] }), retentionSql(scope, { now: 0 })]) {
      expect(sql).toContain("if(blob2 != '', format('u:{}', blob2), format('a:{}', blob3))");
    }
  });

  test("users: rows with neither userId nor anonymousId are not one more user (they still count as events)", () => {
    const users = "count(DISTINCT if(blob2 != '', format('u:{}', blob2), format('a:{}', blob3))) - if(countIf(NOT (blob2 != '' OR blob3 != '')) > 0, 1, 0) AS users";
    expect(topEventsSql(scope)).toContain(`SUM(_sample_interval) AS events, ${users}`);
    expect(overviewSql(scope)).toContain(`SUM(_sample_interval) AS events, ${users}`);
  });

  test("counts: buckets per name, scoped to the install, names on the sampling index", () => {
    const now = 1_764_000_000_000; // ms; 1_764_000_000 s
    expect(countsSql(scope, { names: ["a", "b"], sinceHours: 48, bucket: "day", now })).toBe(
      [
        "SELECT toStartOfInterval(toDateTime(double1 / 1000), INTERVAL '1' DAY) AS t, blob1 AS name, SUM(_sample_interval) AS events",
        "FROM ember_analytics",
        `WHERE blob6 = 'analytics' AND toUnixTimestamp(timestamp) >= ${1_764_000_000 - 49 * 3600} AND double1 > ${now - 172800_000} AND double1 <= ${now} AND index1 IN ('a', 'b')`,
        "GROUP BY t, name",
        "ORDER BY t DESC, name",
        "LIMIT 10000",
      ].join("\n"),
    );
  });

  test("funnel: per-user first times in a subquery, ordered and windowed counts outside, no JOIN", () => {
    const sql = funnelSql(scope, { steps: ["view", "cart", "paid"], windowSeconds: 3600, sinceDays: 14, now: 1_764_000_000_500 });
    expect(sql).toBe(
      [
        "SELECT",
        `  countIf(t0 < ${NEVER_MS}) AS step0,`,
        `  countIf(t0 < ${NEVER_MS} AND t1 >= t0 AND t1 - t0 <= 3600000) AS step1,`,
        `  countIf(t0 < ${NEVER_MS} AND t1 >= t0 AND t2 >= t1 AND t2 - t0 <= 3600000) AS step2`,
        "FROM (",
        "  SELECT if(blob2 != '', format('u:{}', blob2), format('a:{}', blob3)) AS uid,",
        // Milliseconds (double1): a purchase at .100 and a view at .200 of the same second are not view → purchase, and
        // a step 1 ms past the window is out.
        `    min(if(blob1 = 'view', double1, ${NEVER_MS})) AS t0,`,
        `    min(if(blob1 = 'cart', double1, ${NEVER_MS})) AS t1,`,
        `    min(if(blob1 = 'paid', double1, ${NEVER_MS})) AS t2`,
        "  FROM ember_analytics",
        `  WHERE blob6 = 'analytics' AND toUnixTimestamp(timestamp) >= ${1_764_000_000 - 337 * 3600} AND double1 > ${1_764_000_000_500 - 1209600_000} AND double1 <= 1764000000500 AND index1 IN ('view', 'cart', 'paid') AND (blob2 != '' OR blob3 != '')`,
        "  GROUP BY uid",
        ")",
      ].join("\n"),
    );
    expect(sql).not.toMatch(/\bJOIN\b|\bUNION\b|\bWITH\b|;/i);
  });

  test("retention: a cohort and per-period activity per user inside, returns per cohort outside", () => {
    const now = Date.UTC(2026, 10, 26, 15, 30); // a Thursday
    const start = retentionStart({ period: "week", periods: 3, now });
    expect(new Date(start * 1000).toISOString()).toBe("2026-11-09T00:00:00.000Z"); // the Monday two weeks before
    expect(new Date(retentionStart({ period: "day", periods: 2, now }) * 1000).toISOString()).toBe("2026-11-25T00:00:00.000Z");
    const sql = retentionSql(scope, { period: "week", periods: 3, event: "session", now });
    const idx = `intDiv(${ET} - ${start}, 604800)`;
    expect(sql).toBe(
      [
        "SELECT cohort, count() AS users,",
        "  countIf((cohort = 0 AND a1 > 0) OR (cohort = 1 AND a2 > 0)) AS r1,",
        "  countIf((cohort = 0 AND a2 > 0)) AS r2",
        "FROM (",
        "  SELECT if(blob2 != '', format('u:{}', blob2), format('a:{}', blob3)) AS uid,",
        `    min(${idx}) AS cohort,`,
        `    countIf(${idx} = 0) AS a0,`,
        `    countIf(${idx} = 1) AS a1,`,
        `    countIf(${idx} = 2) AS a2`,
        "  FROM ember_analytics",
        `  WHERE blob6 = 'analytics' AND toUnixTimestamp(timestamp) >= ${start - 3600} AND double1 >= ${start * 1000} AND double1 <= ${now} AND (blob2 != '' OR blob3 != '') AND index1 = 'session'`,
        "  GROUP BY uid",
        ")",
        "GROUP BY cohort",
        "ORDER BY cohort",
      ].join("\n"),
    );
    expect(() => retentionSql(scope, { period: "month" as never, now: 0 })).toThrow(/day or week/);
    expect(retentionSql(scope, { periods: 99, now: 0 })).toContain("a12"); // clamped to 13 periods
    expect(retentionSql(scope, { periods: 99, now: 0 })).not.toContain("a13");
  });
});

const ET = "toUnixTimestamp(toDateTime(double1 / 1000))";

/** A recorded SQL API exchange: the fetch sees the URL, the token and the statement; answers what was recorded. */
function recorded(answer: unknown, status = 200) {
  const calls: Array<{ url: string; auth: string | null; body: string; redirect?: string }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: String(init.body), ...(init.redirect ? { redirect: init.redirect } : {}) });
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { calls, api: { accountId: "acc123", token: "tok", fetch: f } };
}

describe("the SQL API and results", () => {
  afterEach(() => clearSqlCache());

  test("funnel against a recorded answer: conversions from step 1 and from the step before", async () => {
    // A fixed now: the statement sent and the one it is compared with have the same cutoff, whatever the clock does.
    const o = { steps: ["view", "cart", "paid"], windowSeconds: 86400, now: Date.UTC(2026, 10, 26, 10, 1) };
    // FORMAT JSON as the API answers it (UInt64 counts come back as strings).
    const { calls, api } = recorded({ meta: [{ name: "step0", type: "UInt64" }], data: [{ step0: "200", step1: "50", step2: 10 }], rows: 1 });
    const r = parseFunnel(await runSql(api, funnelSql(scope, o)), o);
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql");
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(calls[0]!.redirect).toBe("manual"); // the token never follows a redirect
    expect(calls[0]!.body).toBe(funnelSql(scope, o));
    expect(r.steps).toEqual([
      { step: 1, name: "view", users: 200, conversion: 1, fromPrevious: 1 },
      { step: 2, name: "cart", users: 50, conversion: 0.25, fromPrevious: 0.25 },
      { step: 3, name: "paid", users: 10, conversion: 0.05, fromPrevious: 0.2 },
    ]);
    expect(parseFunnel({ data: [] }, o).steps.map((s) => [s.users, s.conversion])).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  test("retention against a recorded answer: one row per cohort, only the periods that happened", async () => {
    const now = Date.UTC(2026, 10, 26);
    const o = { period: "day" as const, periods: 3, now };
    const { api } = recorded({ data: [{ cohort: 0, users: "10", r1: "4", r2: "2" }, { cohort: "1", users: 5, r1: 1, r2: 0 }, { cohort: 2, users: 3, r1: 0, r2: 0 }, { cohort: 7, users: 1 }] });
    const r = parseRetention(await runSql(api, retentionSql(scope, o)), o);
    const start = retentionStart(o) * 1000;
    expect(r).toEqual({
      period: "day",
      periods: 3,
      start,
      cohorts: [
        { start, users: 10, retained: [4, 2], rates: [0.4, 0.2] },
        { start: start + 86400_000, users: 5, retained: [1], rates: [0.2] },
        { start: start + 2 * 86400_000, users: 3, retained: [], rates: [] },
      ],
    });
  });

  test("API errors carry the status; a non-JSON answer is an error", async () => {
    await expect(runSql(recorded("unauthorized", 401).api, "SELECT 1")).rejects.toMatchObject({ name: "SqlApiError", status: 401 });
    await expect(runSql(recorded("<html>", 200).api, "SELECT 1")).rejects.toBeInstanceOf(SqlApiError);
  });

  test("a failed request or body read, and an answer without data rows, are SqlApiError 502 (never cached)", async () => {
    const base = { accountId: "acc", token: "tok" };
    const offline = (async () => Promise.reject(new TypeError("network down"))) as unknown as typeof fetch;
    await expect(runSql({ ...base, fetch: offline }, "SELECT 1")).rejects.toMatchObject({ name: "SqlApiError", status: 502 });
    const brokenBody = (async () => ({ ok: true, status: 200, text: async () => Promise.reject(new Error("reset")) })) as unknown as typeof fetch;
    await expect(runSql({ ...base, fetch: brokenBody }, "SELECT 1")).rejects.toMatchObject({ name: "SqlApiError", status: 502 });
    // A non-2xx whose body read fails keeps the upstream status.
    const brokenDenied = (async () => ({ ok: false, status: 401, text: async () => Promise.reject(new Error("reset")) })) as unknown as typeof fetch;
    await expect(runSql({ ...base, fetch: brokenDenied }, "SELECT 1")).rejects.toMatchObject({ name: "SqlApiError", status: 401 });
    for (const bad of [{}, { data: {} }, { data: [1] }, { data: [[]] }, null]) {
      await expect(runSql(recorded(bad).api, "SELECT 1")).rejects.toMatchObject({ name: "SqlApiError", status: 502 });
    }
    await expect(runSql(recorded({ data: [] }).api, "SELECT 1")).resolves.toEqual({ data: [] });
    const { calls, api } = recorded({});
    const cache: CacheLike = { match: async () => undefined, put: async () => undefined };
    for (let i = 0; i < 2; i++) await expect(cachedSql(api, "SELECT 9", { ttlSeconds: 60, now: 1, cache })).rejects.toBeInstanceOf(SqlApiError);
    expect(calls).toHaveLength(2);
  });

  test("cachedSql: the same statement within the TTL is one API call (memory, then the Cache API)", async () => {
    const { calls, api } = recorded({ data: [{ n: 1 }] });
    const store = new Map<string, Response>();
    const cache: CacheLike = { match: async (k) => store.get(k)?.clone(), put: async (k, r) => void store.set(k, r) };
    const t0 = 1_000_000;
    expect((await cachedSql(api, "SELECT 1", { ttlSeconds: 60, now: t0, cache })).data).toEqual([{ n: 1 }]);
    expect(await cachedSql(api, "SELECT 1", { ttlSeconds: 60, now: t0 + 30_000, cache })).toMatchObject({ cached: true });
    expect(calls).toHaveLength(1);
    // Another isolate (empty memory) finds it in the Cache API; the key never holds the token.
    clearSqlCache();
    expect(await cachedSql(api, "SELECT 1", { ttlSeconds: 60, now: t0 + 40_000, cache })).toMatchObject({ cached: true });
    expect(calls).toHaveLength(1);
    expect([...store.keys()].join()).not.toContain("tok");
    // Past the TTL: asked again. TTL 0: never cached.
    await cachedSql(api, "SELECT 1", { ttlSeconds: 60, now: t0 + 61_000, cache });
    expect(calls).toHaveLength(2);
    await cachedSql(api, "SELECT 1", { ttlSeconds: 0, cache });
    await cachedSql(api, "SELECT 1", { ttlSeconds: 0, cache });
    expect(calls).toHaveLength(4);
  });

  test("cachedSql: the memory stays within its cap, also when the answers come from the Cache API", async () => {
    const { api } = recorded({ data: [] });
    const store = new Map<string, Response>();
    const cache: CacheLike = { match: async (k) => store.get(k)?.clone(), put: async (k, r) => void store.set(k, r) };
    for (let i = 0; i < 250; i++) await cachedSql(api, `SELECT ${i}`, { ttlSeconds: 60, now: 1000, cache });
    clearSqlCache();
    // Another isolate: every answer is a Cache API hit, each one remembered in memory.
    for (let i = 0; i < 250; i++) expect(await cachedSql(api, `SELECT ${i}`, { ttlSeconds: 60, now: 2000, cache })).toMatchObject({ cached: true });
    expect(sqlCacheSize()).toBe(200);
  });

  test("the SQL API base: https only (plain http only to the loopback); the token never goes in the clear", async () => {
    const { calls, api } = recorded({ data: [] });
    for (const base of ["http://api.example.com/client/v4", "ftp://x/", "not a url", "http://localhost.evil.example/v4"]) {
      await expect(runSql({ ...api, base }, "SELECT 1")).rejects.toBeInstanceOf(SqlApiError);
    }
    expect(calls).toHaveLength(0);
    for (const base of ["https://api.example.com/client/v4", "http://localhost:8787/v4", "http://127.0.0.1:9/v4", "http://[::1]:9/v4"]) await runSql({ ...api, base }, "SELECT 1");
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["api.example.com", "localhost:8787", "127.0.0.1:9", "[::1]:9"]);
    expect(checkBase(SQL_API_BASE)).toBe(SQL_API_BASE);
  });

  test("cachedSql: a rotated token or another base URL never reads the cached answer", async () => {
    const { calls, api } = recorded({ data: [{ n: 1 }] });
    const store = new Map<string, Response>();
    const cache: CacheLike = { match: async (k) => store.get(k)?.clone(), put: async (k, r) => void store.set(k, r) };
    const t0 = 1_000_000;
    await cachedSql(api, "SELECT 1", { ttlSeconds: 60, now: t0, cache });
    expect(await cachedSql({ ...api, token: "rotated" }, "SELECT 1", { ttlSeconds: 60, now: t0 + 1000, cache })).not.toHaveProperty("cached");
    expect(calls.map((c) => c.auth)).toEqual(["Bearer tok", "Bearer rotated"]);
    expect(await cachedSql({ ...api, base: "https://other.example/v4" }, "SELECT 1", { ttlSeconds: 60, now: t0 + 2000, cache })).not.toHaveProperty("cached");
    expect(calls).toHaveLength(3);
    // The same credential still hits.
    expect(await cachedSql(api, "SELECT 1", { ttlSeconds: 60, now: t0 + 3000, cache })).toMatchObject({ cached: true });
    expect([...store.keys()].join()).not.toMatch(/tok|rotated/);
  });
});
