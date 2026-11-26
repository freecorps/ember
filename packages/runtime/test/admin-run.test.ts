// Dashboard function runner and reactivity screen (admin-api.ts, reactivity.ts): run any function (internal ones
// too) as a given user without minting a token, refuse sensitive ones when acting, list functions with their args,
// and report live subscriptions, re-runs per commit and the `ember dev` advice.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { queryAdvice } from "../src/reactivity.ts";
import { connect, hello, is } from "./helpers.ts";

type Patch = Extract<ServerMessage, { t: "patch" }>;

const admin = (path: string, body?: unknown) =>
  SELF.fetch(`http://ember/api/_ember/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer admin-secret", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("functions and the runner", () => {
  it("readOnly: runs queries only, by this deployment's own function types (ember mcp without confirm)", async () => {
    const shard = "dash:readonly";
    const q = await admin("run", { fn: "messages:list", args: { channel: "ro" }, shard, readOnly: true });
    expect(q.body).toMatchObject({ ok: true, type: "query" });
    for (const [fn, args, type] of [["messages:send", { channel: "ro", body: "x" }, "mutation"], ["actions:combo", { channel: "ro" }, "action"]] as const) {
      const r = await admin("run", { fn, args, shard, readOnly: true });
      expect([fn, r.status, r.body.error.code]).toEqual([fn, 403, "confirm_required"]);
      expect(r.body.error.message).toContain(`is a ${type} in this deployment`);
    }
    // Nothing was written by the refused mutation.
    expect((await admin("run", { fn: "messages:list", args: { channel: "ro" }, shard })).body.value).toEqual([]);
    expect((await admin("run", { fn: "messages:list", args: { channel: "ro" }, shard, readOnly: "yes" })).status).toBe(400);
  });

  it("x-ember-env: a caller naming another environment is refused before any admin endpoint runs", async () => {
    const call = (path: string, envName: string, init: RequestInit = {}) =>
      SELF.fetch(`http://ember/api/_ember/${path}`, { ...init, headers: { authorization: "Bearer admin-secret", "x-ember-env": envName, "content-type": "application/json" } });
    // The test Worker's EMBER_ENV is "test".
    expect((await call("status?shard=global:main", "test")).status).toBe(200);
    for (const [path, init] of [["status?shard=global:main", {}], ["data?shard=global:main", {}], ["inspect?shard=global:main", {}], ["run", { method: "POST", body: JSON.stringify({ fn: "messages:send", args: { channel: "env", body: "x" }, shard: "dash:env" }) }]] as const) {
      const r = await call(path, "prod", init);
      const body = (await r.json()) as { error: { code: string; message: string } };
      expect([path, r.status, body.error.code]).toEqual([path, 409, "wrong_environment"]);
      expect(body.error.message).toMatch(/serves the environment "test", not "prod"/);
    }
    expect((await admin("run", { fn: "messages:list", args: { channel: "env" }, shard: "dash:env" })).body.value).toEqual([]);
    // The admin token is still checked first.
    expect((await SELF.fetch("http://ember/api/_ember/status", { headers: { "x-ember-env": "prod" } })).status).toBe(401);
  });

  it("lists the app's functions with their args shape; not the dashboard's own module", async () => {
    const r = await admin("functions");
    const byName = new Map<string, any>(r.body.functions.map((f: { name: string }) => [f.name, f]));
    expect(byName.get("messages:send")).toMatchObject({ type: "mutation", visibility: "public", args: { kind: "object" } });
    expect(byName.get("messages:secret")).toMatchObject({ type: "query", visibility: "internal" });
    expect(byName.get("auth:transfer")).toMatchObject({ sensitive: true });
    expect([...byName.keys()].some((n) => n.startsWith("_ember:"))).toBe(false);
  });

  it("runs queries, mutations and actions (internal included), as a user when asked; nothing returns a token", async () => {
    const shard = "dash:run";
    const q = await admin("run", { fn: "messages:secret", args: {}, shard });
    expect(q.body).toMatchObject({ ok: true, value: "classified", type: "query", as: null });
    expect(q.body.ms).toBeTypeOf("number");
    const anon = await admin("run", { fn: "auth:whoami", args: {}, shard });
    expect(anon.body.value).toBeNull();
    const asAna = await admin("run", { fn: "auth:whoami", args: {}, shard, as: { subject: "user_ana" } });
    expect(asAna.body).toMatchObject({ ok: true, value: "user_ana", as: "user_ana" });
    expect(JSON.stringify(asAna.body)).not.toMatch(/eyJ|token/i);
    // A mutation as the user: the message is attributed to them.
    const sent = await admin("run", { fn: "messages:send", args: { channel: "run", body: "hi" }, shard, as: { subject: "user_ana" } });
    expect(sent.body.ok).toBe(true);
    const list = await admin("run", { fn: "messages:list", args: { channel: "run" }, shard });
    expect(list.body.value).toMatchObject([{ body: "hi", author: "user_ana" }]);
    // Actions run in the Worker with the same identity.
    const act = await admin("run", { fn: "actions:combo", args: { channel: "run2" }, shard, as: { subject: "user_bo" } });
    expect(act.body).toMatchObject({ ok: true, type: "action" });
    expect(act.body.value.who).toBe("user_bo");
    // Function errors come back as the outcome (400), with the engine's code.
    const bad = await admin("run", { fn: "messages:send", args: { channel: 1 }, shard });
    expect([bad.status, bad.body.ok, bad.body.error.code]).toEqual([400, false, "ValidationError"]);
  });

  it("refuses sensitive functions when acting as a user, unknown functions and the _ember module", async () => {
    const shard = "dash:refuse";
    const s = await admin("run", { fn: "auth:transfer", args: { amount: 1 }, shard, as: { subject: "user_ana" } });
    expect([s.status, s.body.error.code]).toEqual([403, "sensitive_refused"]);
    expect((await admin("run", { fn: "auth:wipe", args: {}, shard, as: { subject: "user_ana" } })).status).toBe(403);
    expect((await admin("run", { fn: "nope:nope", args: {}, shard })).status).toBe(404);
    expect((await admin("run", { fn: "_ember:dataInsert", args: { table: "messages", doc: {} }, shard })).status).toBe(404);
    expect((await admin("run", { fn: "auth:whoami", args: {}, shard, as: { subject: "" } })).status).toBe(400);
    expect((await admin("run", { fn: "auth:whoami", args: [], shard })).status).toBe(400);
  });
});

describe("reactivity", () => {
  it("reports live subscriptions, shared vs per-user results and re-runs per commit; profiles one entry on demand", async () => {
    const shard = "dash:rx";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b);
    a.send({ t: "sub", qid: "l", fn: "messages:list", args: { channel: "rx" } });
    b.send({ t: "sub", qid: "l", fn: "messages:list", args: { channel: "rx" } });
    await a.waitFor(is("snap"));
    await b.waitFor(is("snap"));
    a.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "rx", body: "one" } });
    await a.waitFor<Patch>(is("patch"));
    await b.waitFor<Patch>(is("patch"));
    const r = await admin(`reactivity?shard=${shard}`);
    expect(r.status).toBe(200);
    const report = r.body.report;
    expect(report).toMatchObject({ shard, subscriptions: 2, sockets: 2 });
    const entry = report.entries.find((e: { fn: string }) => e.fn === "messages:list");
    expect(entry).toMatchObject({ shared: true, subscribers: 2, returned: 1, runs: 1, changed: 1, error: null });
    expect(entry.reads.join(" ")).toMatch(/messages\./);
    expect(report.commits[0]).toMatchObject({ reran: 1, changed: 1 });
    const p = await admin(`reactivity/profile?shard=${shard}&key=${encodeURIComponent(entry.key)}`);
    expect(p.body.profile).toMatchObject({ fn: "messages:list", returned: 1, identityRead: false, error: null });
    expect(p.body.profile.read).toBeGreaterThanOrEqual(1);
    expect((await admin(`reactivity/profile?shard=${shard}&key=gone`)).status).toBe(404);
    a.close();
    b.close();
  });

  it("the advice is the same as ember dev's", () => {
    const advice = queryAdvice({ read: 5000, returned: 3, profile: { scanned: 5000, filteredOut: 4997, collectRows: 5000, sql: 0 } }, true);
    expect(advice.map((a) => a.kind)).toEqual(["filter", "collect", "identity", "reads"]);
    expect(queryAdvice({ read: 3, returned: 3, profile: { scanned: 3, filteredOut: 0, collectRows: 3, sql: 0 } }, false)).toEqual([]);
  });
});
