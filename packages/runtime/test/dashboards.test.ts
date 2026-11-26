// Declarative screens through the admin API (admin-api.ts, contracts.md "Telas declarativas"): the specs of the app
// and its components, and running only the functions a spec names — queries through `dashboards/query`, writes
// through `dashboards/run` — with the function's validators checked first.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_API_LEVEL } from "../src/index.ts";

type Reply = { status: number; body: any };
const get = (path: string, token = "admin-secret"): Promise<Reply> =>
  SELF.fetch(`http://ember/api/_ember/${path}`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (path: string, body: unknown): Promise<Reply> =>
  SELF.fetch(`http://ember/api/_ember/${path}`, { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const query = (dashboard: string, fn: string, args: unknown, shard?: string) => get(`dashboards/query?${new URLSearchParams({ dashboard, fn, args: JSON.stringify(args), ...(shard ? { shard } : {}) })}`);

describe("dashboards (admin API)", () => {
  it("lists the app's spec and each install's, with the functions they run; capabilities name the endpoints", async () => {
    const caps = await get("capabilities");
    expect(caps.body.level).toBe(ADMIN_API_LEVEL);
    expect(caps.body.features).toEqual(expect.arrayContaining(["dashboards", "dashboards/query", "dashboards/run"]));
    const r = await get("dashboards");
    expect(r.status).toBe(200);
    const byKey = new Map<string, any>(r.body.dashboards.map((d: { key: string }) => [d.key, d]));
    expect(byKey.get("")).toMatchObject({ component: null, label: "Runs", scope: "global" });
    const tally = byKey.get("tally");
    expect(tally).toMatchObject({ component: "tally", label: "Tallies", icon: "gauge", scope: "shard" });
    expect(Object.keys(tally.functions).sort()).toEqual(["@tally/lib:bump", "@tally/lib:bumpTwice", "@tally/lib:get", "@tally/lib:list", "@tally/lib:reset"]);
    expect(tally.functions["@tally/lib:reset"]).toMatchObject({ type: "mutation", destructive: true });
    expect(tally.tabs[0].blocks[1]).toMatchObject({ kind: "table", query: "@tally/lib:list", filters: ["min"] });
    // Needs the admin token like every admin endpoint.
    expect((await get("dashboards", "wrong")).status).toBe(401);
  });

  it("runs the queries and writes the spec names, on the chosen shard", async () => {
    const shard = "dash:screens";
    const bumped = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:bump", args: { key: "dash", by: 2 }, shard });
    expect(bumped).toMatchObject({ status: 200, body: { ok: true, value: 2, type: "mutation", shard } });
    // Actions run in the Worker.
    const twice = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:bumpTwice", args: { key: "dash" }, shard });
    expect(twice.body).toMatchObject({ ok: true, value: 4, type: "action" });
    const stat = await query("tally", "@tally/lib:get", { key: "dash" }, shard);
    expect(stat).toMatchObject({ status: 200, body: { ok: true, value: 4, type: "query" } });
    const list = await query("tally", "@tally/lib:list", { min: 1 }, shard);
    expect(list.body.value.map((t: { key: string; n: number }) => [t.key, t.n])).toEqual([["dash", 4]]);
    // Another shard has its own tables.
    expect((await query("tally", "@tally/lib:list", {}, "dash:other")).body.value).toEqual([]);
    // A destructive function runs only for a caller that confirmed it as one (the dashboard read the same spec).
    const unconfirmed = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:reset", args: { key: "dash" }, shard });
    expect([unconfirmed.status, unconfirmed.body.error.code]).toEqual([409, "dashboard_changed"]);
    expect((await query("tally", "@tally/lib:get", { key: "dash" }, shard)).body.value).toBe(4);
    const reset = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:reset", args: { key: "dash" }, shard, destructive: true });
    expect(reset.body).toMatchObject({ ok: true, value: true });
    expect((await query("tally", "@tally/lib:get", { key: "dash" }, shard)).body.value).toBe(0);
  });

  it("refuses functions the spec does not name (even the component's own), and the wrong endpoint for a kind", async () => {
    const shard = "dash:refuse";
    // Internal function of the same component, not in the spec.
    const sneak = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:applyLater", args: { key: "x" }, shard });
    expect([sneak.status, sneak.body.error.code]).toEqual([403, "not_in_dashboard"]);
    // Public, but not in the spec.
    expect((await query("tally", "@tally/lib:label", {}, shard)).body.error.code).toBe("not_in_dashboard");
    // Another dashboard's function.
    expect((await post("dashboards/run", { dashboard: "", fn: "@tally/lib:bump", args: { key: "x", by: 1 } })).status).toBe(403);
    // A write through the read endpoint, a query through the write endpoint.
    const writeAsRead = await query("tally", "@tally/lib:bump", { key: "x", by: 1 }, shard);
    expect([writeAsRead.status, writeAsRead.body.error.code]).toEqual([403, "not_in_dashboard"]);
    expect((await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:list", args: {}, shard })).status).toBe(403);
    expect((await query("tally", "@tally/lib:list", {}, shard)).body.value).toEqual([]);
    expect((await get(`dashboards/query?${new URLSearchParams({ dashboard: "nope", fn: "x" })}`)).status).toBe(404);
    // Methods.
    expect((await get("dashboards/run")).status).toBe(405);
  });

  it("checks args with the function's validators before running; a global spec runs on global:main only", async () => {
    const bad = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:bump", args: { key: "x", by: "one" }, shard: "dash:args" });
    expect([bad.status, bad.body.error.code]).toEqual([400, "ValidationError"]);
    expect(bad.body.error.message).toMatch(/@tally\/lib:bump/);
    expect((await query("tally", "@tally/lib:get", { key: "x" }, "dash:args")).body.value).toBe(0);
    expect((await get(`dashboards/query?${new URLSearchParams({ dashboard: "tally", fn: "@tally/lib:get", args: "{nope" })}`)).status).toBe(400);
    // Args that are JSON but not an object: refused before anything else (even an unknown dashboard).
    for (const args of ["5", "[1]", "null", '"x"']) {
      const r = await get(`dashboards/query?${new URLSearchParams({ dashboard: "nope", fn: "x", args })}`);
      expect([r.status, r.body.error.code, r.body.error.message]).toEqual([400, "bad_request", "args must be a JSON object"]);
    }
    expect((await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:bump", args: [1], shard: "dash:args" })).status).toBe(400);
    // An explicit null is not "no args"; a shard that is not a string is not global:main.
    const nullArgs = await post("dashboards/run", { dashboard: "", fn: "components:bump", args: null });
    expect([nullArgs.status, nullArgs.body.error.code]).toEqual([400, "bad_request"]);
    for (const shard of [42, "", null]) {
      const r = await post("dashboards/run", { dashboard: "tally", fn: "@tally/lib:bump", args: { key: "x", by: 1 }, shard });
      expect([r.status, r.body.error.code], String(shard)).toEqual([400, "bad_shard"]);
    }
    expect((await query("tally", "@tally/lib:get", { key: "x" }, "global:main")).body.value).toBe(0);
    // The app's screen is global.
    const app = await query("", "components:count", { key: "g" });
    expect(app.body).toMatchObject({ ok: true, value: 0, shard: "global:main" });
    const elsewhere = await query("", "components:count", { key: "g" }, "dash:args");
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([400, "bad_shard"]);
    expect((await post("dashboards/run", { dashboard: "", fn: "components:bump", args: { key: "g" } })).body).toMatchObject({ ok: true, value: 1, shard: "global:main" });
  });

  it("serves an embed block's page: only a route the spec names, anonymously, with only its type and body", async () => {
    const caps = await get("capabilities");
    expect(caps.body.features).toContain("dashboards/embed");
    const spec = (await get("dashboards")).body.dashboards.find((d: { key: string }) => d.key === "tally");
    expect(spec.tabs[1].blocks[0]).toEqual({ kind: "embed", id: "page", route: "/dashboard/page", path: "/tally/dashboard/page", height: "auto", functions: { "lib:get": "@tally/lib:get", "lib:bump": "@tally/lib:bump" } });
    const embed = (dashboard: string, route: string, token = "admin-secret") => SELF.fetch(`http://ember/api/_ember/dashboards/embed?${new URLSearchParams({ dashboard, route })}`, { headers: { authorization: `Bearer ${token}` } });
    const ok = await embed("tally", "/dashboard/page");
    expect(ok.status).toBe(200);
    // Run anonymously: the admin token never reaches the route; its own headers (a cookie) are dropped.
    expect(await ok.text()).toBe("<!doctype html><p>tally page anonymous</p>");
    expect(ok.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(ok.headers.get("set-cookie")).toBeNull();
    expect(ok.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    // A route no embed block names (even one the component serves), another spec, or no token: refused.
    const other = await embed("tally", "/hit");
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("unknown_embed");
    expect((await embed("nope", "/dashboard/page")).status).toBe(404);
    expect((await embed("", "/dashboard/page")).status).toBe(404);
    expect((await embed("tally", "/dashboard/page", "wrong")).status).toBe(401);
    expect((await SELF.fetch("http://ember/api/_ember/dashboards/embed?dashboard=tally&route=%2Fdashboard%2Fpage", { method: "POST", headers: { authorization: "Bearer admin-secret" } })).status).toBe(405);
  });

  it("an embed page over 1 MiB is refused even when the route streams it without content-length", async () => {
    const big = await SELF.fetch(`http://ember/api/_ember/dashboards/embed?${new URLSearchParams({ dashboard: "tally", route: "/dashboard/big" })}`, { headers: { authorization: "Bearer admin-secret" } });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("too_large");
  });

  it("an embed page is served by its own install's route, never by another scope's route at the same path", async () => {
    // The app serves a route at /tally/dashboard/shadowed, the mounted path of tally's embed: ingress picks the app's,
    // the embed always tally's own.
    expect(await (await SELF.fetch("http://ember/tally/dashboard/shadowed")).text()).toBe("<p>the app's page</p>");
    const res = await SELF.fetch(`http://ember/api/_ember/dashboards/embed?${new URLSearchParams({ dashboard: "tally", route: "/dashboard/shadowed" })}`, { headers: { authorization: "Bearer admin-secret" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>tally's own page</p>");
  });
});
