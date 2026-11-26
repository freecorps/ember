// The SQL builders: inputs can never reach the text unchecked (adversarial names), and the funnel / retention
// statements have the shape Analytics Engine SQL takes (one table, subquery in FROM, no JOIN), checked against a
// recorded SQL API answer.
import { afterEach, describe, expect, test } from "vitest";
import {
  cachedSql,
  clearSqlCache,
  countsSql,
  funnelSql,
  lit,
  NEVER,
  overviewSql,
  parseFunnel,
  parseRetention,
  retentionSql,
  retentionStart,
  runSql,
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
      expect(() => retentionSql(scope, { event: bad })).toThrow(SqlInputError);
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
    expect(countsSql(scope, { sinceHours: 1e9 })).toContain("INTERVAL '2160' HOUR");
    expect(countsSql(scope, { sinceHours: -5 })).toContain("INTERVAL '1' HOUR");
    expect(topEventsSql(scope, { limit: 3.9 })).toContain("LIMIT 3");
    expect(() => topEventsSql(scope, { limit: "1; DROP" as unknown as number })).toThrow(SqlInputError);
    expect(() => funnelSql(scope, { steps: ["a", "b"], windowSeconds: Number.NaN })).toThrow(SqlInputError);
    expect(() => countsSql(scope, { bucket: "hour) --" as never })).toThrow(SqlInputError);
  });

  test("bucket and period are own keys: Object.prototype names are refused", () => {
    for (const bad of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(() => countsSql(scope, { bucket: bad as never })).toThrow(/minute, hour or day/);
      expect(() => retentionSql(scope, { period: bad as never })).toThrow(/day or week/);
      expect(() => retentionStart({ period: bad as never })).toThrow(/day or week/);
      expect(() => parseRetention({ data: [{ cohort: 0, users: 1 }] }, { period: bad as never })).toThrow(/day or week/);
    }
    expect(() => parseRetention({ data: [] }, { period: "month" as never })).toThrow(SqlInputError);
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
  });
});

describe("statement shapes", () => {
  test("counts: buckets per name, scoped to the install, names on the sampling index", () => {
    expect(countsSql(scope, { names: ["a", "b"], sinceHours: 48, bucket: "day" })).toBe(
      [
        "SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS t, blob1 AS name, SUM(_sample_interval) AS events",
        "FROM ember_analytics",
        "WHERE blob6 = 'analytics' AND timestamp > NOW() - INTERVAL '48' HOUR AND index1 IN ('a', 'b')",
        "GROUP BY t, name",
        "ORDER BY t, name",
        "LIMIT 10000",
      ].join("\n"),
    );
  });

  test("funnel: per-user first times in a subquery, ordered and windowed counts outside, no JOIN", () => {
    const sql = funnelSql(scope, { steps: ["view", "cart", "paid"], windowSeconds: 3600, sinceDays: 14 });
    expect(sql).toBe(
      [
        "SELECT",
        `  countIf(t0 < ${NEVER}) AS step0,`,
        `  countIf(t0 < ${NEVER} AND t1 >= t0 AND t1 - t0 <= 3600) AS step1,`,
        `  countIf(t0 < ${NEVER} AND t1 >= t0 AND t2 >= t1 AND t2 - t0 <= 3600) AS step2`,
        "FROM (",
        "  SELECT if(blob2 != '', blob2, blob3) AS uid,",
        `    min(if(blob1 = 'view', toUnixTimestamp(timestamp), ${NEVER})) AS t0,`,
        `    min(if(blob1 = 'cart', toUnixTimestamp(timestamp), ${NEVER})) AS t1,`,
        `    min(if(blob1 = 'paid', toUnixTimestamp(timestamp), ${NEVER})) AS t2`,
        "  FROM ember_analytics",
        "  WHERE blob6 = 'analytics' AND timestamp > NOW() - INTERVAL '14' DAY AND index1 IN ('view', 'cart', 'paid') AND (blob2 != '' OR blob3 != '')",
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
    const idx = `intDiv(toUnixTimestamp(timestamp) - ${start}, 604800)`;
    expect(sql).toBe(
      [
        "SELECT cohort, count() AS users,",
        "  countIf((cohort = 0 AND a1 > 0) OR (cohort = 1 AND a2 > 0)) AS r1,",
        "  countIf((cohort = 0 AND a2 > 0)) AS r2",
        "FROM (",
        "  SELECT if(blob2 != '', blob2, blob3) AS uid,",
        `    min(${idx}) AS cohort,`,
        `    countIf(${idx} = 0) AS a0,`,
        `    countIf(${idx} = 1) AS a1,`,
        `    countIf(${idx} = 2) AS a2`,
        "  FROM ember_analytics",
        `  WHERE blob6 = 'analytics' AND toUnixTimestamp(timestamp) >= ${start} AND (blob2 != '' OR blob3 != '') AND index1 = 'session'`,
        "  GROUP BY uid",
        ")",
        "GROUP BY cohort",
        "ORDER BY cohort",
      ].join("\n"),
    );
    expect(() => retentionSql(scope, { period: "month" as never })).toThrow(/day or week/);
    expect(retentionSql(scope, { periods: 99 })).toContain("a12"); // clamped to 13 periods
    expect(retentionSql(scope, { periods: 99 })).not.toContain("a13");
  });
});

/** A recorded SQL API exchange: the fetch sees the URL, the token and the statement; answers what was recorded. */
function recorded(answer: unknown, status = 200) {
  const calls: Array<{ url: string; auth: string | null; body: string }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { calls, api: { accountId: "acc123", token: "tok", fetch: f } };
}

describe("the SQL API and results", () => {
  afterEach(() => clearSqlCache());

  test("funnel against a recorded answer: conversions from step 1 and from the step before", async () => {
    const o = { steps: ["view", "cart", "paid"], windowSeconds: 86400 };
    // FORMAT JSON as the API answers it (UInt64 counts come back as strings).
    const { calls, api } = recorded({ meta: [{ name: "step0", type: "UInt64" }], data: [{ step0: "200", step1: "50", step2: 10 }], rows: 1 });
    const r = parseFunnel(await runSql(api, funnelSql(scope, o)), o);
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql");
    expect(calls[0]!.auth).toBe("Bearer tok");
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
