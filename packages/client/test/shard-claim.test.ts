// `shard: { org: fromAuth("org") }` (docs/design/dx.md §3.6, PLAN §22 L1): the client routes a reference whose spec is
// `{ kind, fromClaim }` to `<kind>:<claim>` of the current token (its JWT payload, read without verifying: the shard
// checks it). When the token's claim changes (another active org), subscriptions move to the new shard.
import { describe, expect, it } from "vitest";
import { FUNCTION_SHARD, makeFunctionReference, watchPaginatedQuery, type FunctionReference, type OnShardLike, type QuerySnapshot } from "../src/index.ts";
import { FakeFunctionError, type FakeCtx } from "../src/testing.ts";
import { makeClient, messagesServer, tick, until } from "./helpers.ts";

const jwt = (payload: object) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
const decode = (token: string) => {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { sub: string; [k: string]: unknown };
    const { sub, ...claims } = p;
    return { subject: sub, claims };
  } catch {
    return token === "opaque" ? { subject: "opaque-user" } : null;
  }
};

/** As the engine: the caller's claim must be this shard's key. */
const inOrg = (ctx: FakeCtx) => {
  if (!ctx.identity) throw new FakeFunctionError("Unauthenticated", "not signed in");
  const org = ctx.identity.claims?.org;
  if (`org:${String(org)}` !== ctx.shard) throw new FakeFunctionError("WrongShard", `not in ${ctx.shard}`);
};
function server() {
  return messagesServer({
    verify: decode,
    queries: {
      "notes:list": (db, _args, ctx) => {
        inOrg(ctx);
        return db.all<{ body: string }>("notes").map((n) => `${ctx.shard}/${n.body}`);
      },
      "notes:page": (db, { paginationOpts }, ctx) => {
        inOrg(ctx);
        const all = db.all<{ body: string }>("notes").map((n) => `${ctx.shard}/${n.body}`);
        const from = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
        const page = all.slice(from, from + paginationOpts.numItems);
        return { page, isDone: from + page.length >= all.length, continueCursor: String(from + page.length) };
      },
    },
    mutations: {
      "notes:add": (db, { body }, ctx) => {
        inOrg(ctx);
        return db.insert("notes", { body });
      },
    },
  });
}

function claimRef<F extends FunctionReference<any, any, any, any, any, any>>(name: string): F {
  const ref = makeFunctionReference(name) as unknown as Record<symbol, unknown>;
  ref[FUNCTION_SHARD] = { kind: "org", fromClaim: "org" };
  return ref as unknown as F;
}
type Claimed = OnShardLike<{ kind: "org"; fromClaim: "org" }>;
const list = claimRef<FunctionReference<"query", "public", {}, string[], never> & Claimed>("notes:list");
const page = claimRef<FunctionReference<"query", "public", { paginationOpts: { numItems: number; cursor: string | null } }, { page: string[]; isDone: boolean; continueCursor: string }, never> & Claimed>("notes:page");
const add = claimRef<FunctionReference<"mutation", "public", { body: string }, string, never> & Claimed>("notes:add");

describe("fromAuth routing", () => {
  it("routes queries, mutations and one-shots by the token's claim, with no shard option (typed)", async () => {
    const s = server();
    let token = jwt({ sub: "ana", org: "a" });
    const c = makeClient(s, { defaultShard: undefined as never, auth: () => token });
    await c.mutation(add, { body: "1" });
    expect(s.rows("org:a", "notes").map((n) => n.body)).toEqual(["1"]);
    expect(await c.query(list, {}, { transport: "http" })).toEqual(["org:a/1"]);
    expect(s.httpRequests.at(-1)!.body).toMatchObject({ shard: "org:a" });
    // Named explicitly: as asked (and the shard refuses another org).
    await expect(c.query(list, {}, { shard: "org:b", transport: "http" })).rejects.toMatchObject({ code: "WrongShard" });
    token = jwt({ sub: "ana", org: "a" });
    c.close();
  });

  it("moves a subscription to the new shard when the token's claim changes (another active org)", async () => {
    const s = server();
    s.mutateDirect("org:a", "notes:add", { body: "in a" }, { subject: "x", claims: { org: "a" } });
    s.mutateDirect("org:b", "notes:add", { body: "in b" }, { subject: "x", claims: { org: "b" } });
    let token = jwt({ sub: "ana", org: "a" });
    const c = makeClient(s, { defaultShard: undefined as never, auth: () => token });
    const seen: QuerySnapshot<string[]>[] = [];
    const off = c.subscribe(list, {}, undefined, (snap) => seen.push(snap));
    await until(() => seen.at(-1)?.status === "success");
    expect(seen.at(-1)!.value).toEqual(["org:a/in a"]);
    expect(s.subscriptionCount("org:a")).toBe(1);

    // The user switches the active org: a new token, whose claim is another org.
    token = jwt({ sub: "ana", org: "b" });
    c.setAuth(() => token);
    await until(() => seen.at(-1)?.value?.[0] === "org:b/in b");
    // The old org's value is not shown as the new one's: loading in between, then org b's value.
    const switched = seen.findIndex((x) => x.value?.[0] === "org:b/in b");
    expect(seen.slice(0, switched).some((x) => x.status === "loading")).toBe(true);
    await until(() => s.subscriptionCount("org:a") === 0);
    expect(s.subscriptionCount("org:b")).toBe(1);

    // A mutation now goes to org b; one queued before the switch kept its shard (below).
    await c.mutation(add, { body: "b2" });
    await until(() => seen.at(-1)?.value?.length === 2);
    expect(seen.at(-1)!.value).toEqual(["org:b/in b", "org:b/b2"]);

    // Signed out: no shard any more (Unauthenticated, as the server would answer).
    c.clearAuth();
    await until(() => seen.at(-1)?.status === "error");
    expect(seen.at(-1)!.error).toMatchObject({ code: "Unauthenticated", data: { reason: "signed_out" } });
    await until(() => s.subscriptionCount("org:b") === 0);
    off();
    c.close();
  });

  it("a plain token refresh with the same claim keeps the subscription where it is", async () => {
    const s = server();
    let n = 0;
    const c = makeClient(s, { defaultShard: undefined as never, auth: () => jwt({ sub: "ana", org: "a", n: ++n }) });
    const seen: QuerySnapshot<string[]>[] = [];
    const off = c.subscribe(list, {}, undefined, (snap) => seen.push(snap));
    await until(() => seen.at(-1)?.status === "success");
    const subs = s.history.length;
    c.setAuth(() => jwt({ sub: "ana", org: "a", n: ++n }));
    await tick(20);
    expect(seen.filter((x) => x.status === "loading")).toEqual([]);
    expect(s.history.length).toBe(subs);
    expect(s.subscriptionCount("org:a")).toBe(1);
    off();
    c.close();
  });

  it("an opaque token, or a token without the claim, cannot route (no_shard) unless the shard is named", async () => {
    const s = server();
    const opaque = makeClient(s, { defaultShard: "org:zzz", auth: () => "opaque" });
    await expect(opaque.query(list, {})).rejects.toMatchObject({ code: "no_shard", data: { reason: "opaque_token" } });
    await expect(opaque.mutation(add, { body: "x" })).rejects.toThrow(/not a JWT .*pass \{ shard: "org:<key>" \}/);
    const snaps: QuerySnapshot<string[]>[] = [];
    const off = opaque.subscribe(list, {}, undefined, (x) => snaps.push(x));
    await until(() => snaps.at(-1)?.status === "error");
    expect(snaps.at(-1)!.error).toMatchObject({ code: "no_shard" });
    off();
    const noOrg = makeClient(s, { defaultShard: "org:zzz", auth: () => jwt({ sub: "ana" }) });
    await expect(noOrg.query(list, {})).rejects.toMatchObject({ code: "no_shard", data: { reason: "no_claim" } });
    // With { shard }: the client sends it as is.
    s.mutateDirect("org:a", "notes:add", { body: "n" }, { subject: "x", claims: { org: "a" } });
    const named = makeClient(s, { auth: () => jwt({ sub: "ana", org: "a" }) });
    expect(await named.query(list, {}, { shard: "org:a", transport: "http" })).toEqual(["org:a/n"]);
    for (const c of [opaque, noOrg, named]) c.close();
  });

  it("a token that cannot be fetched is an error (auth_failed), and the next call that fetches one recovers", async () => {
    const s = server();
    s.mutateDirect("org:a", "notes:add", { body: "n" }, { subject: "x", claims: { org: "a" } });
    let fail = true;
    const c = makeClient(s, {
      defaultShard: undefined as never,
      auth: () => {
        if (fail) throw new Error("token endpoint down");
        return jwt({ sub: "ana", org: "a" });
      },
    });
    const seen: QuerySnapshot<string[]>[] = [];
    const off = c.subscribe(list, {}, undefined, (snap) => seen.push(snap));
    await until(() => seen.at(-1)?.status === "error");
    expect(seen.at(-1)!.error).toMatchObject({ code: "auth_failed", message: expect.stringContaining("token endpoint down") });
    fail = false;
    expect(await c.query(list, {}, { transport: "http" })).toEqual(["org:a/n"]);
    await until(() => seen.at(-1)?.status === "success");
    expect(seen.at(-1)!.value).toEqual(["org:a/n"]);
    off();
    c.close();
  });

  it("a mutation queued offline keeps the shard of the claim it was queued under", async () => {
    const s = server();
    let token = jwt({ sub: "ana", org: "a" });
    let online = false;
    let emit: (e: "online" | "offline") => void = () => {};
    const c = makeClient(s, {
      defaultShard: undefined as never,
      auth: () => token,
      connectivity: { isOnline: () => online, subscribe: (e) => ((emit = e as typeof emit), () => {}) },
    });
    const queued = c.mutation(add, { body: "queued in a" });
    await until(() => c.connectionState().pendingMutations === 1);
    token = jwt({ sub: "ana", org: "b" });
    c.setAuth(() => token);
    online = true;
    emit("online");
    // Sent to org:a under the new token: the shard refuses it there (the claim is b now), as it should.
    await expect(queued).rejects.toMatchObject({ code: "WrongShard" });
    expect(s.rows("org:b", "notes")).toEqual([]);
    c.close();
  });

  it("paginated queries follow the claim too", async () => {
    const s = server();
    for (const b of ["1", "2", "3"]) s.mutateDirect("org:a", "notes:add", { body: b }, { subject: "x", claims: { org: "a" } });
    s.mutateDirect("org:b", "notes:add", { body: "x" }, { subject: "x", claims: { org: "b" } });
    let token = jwt({ sub: "ana", org: "a" });
    const c = makeClient(s, { defaultShard: undefined as never, auth: () => token });
    const h = watchPaginatedQuery<string>(c, page, {}, { initialNumItems: 2 });
    const off = h.subscribe(() => {});
    await until(() => h.getSnapshot().status === "CanLoadMore");
    expect(h.getSnapshot().results).toEqual(["org:a/1", "org:a/2"]);
    h.loadMore(2);
    await until(() => h.getSnapshot().status === "Exhausted");
    expect(h.getSnapshot().results).toEqual(["org:a/1", "org:a/2", "org:a/3"]);
    token = jwt({ sub: "ana", org: "b" });
    c.setAuth(() => token);
    await until(() => h.getSnapshot().results[0] === "org:b/x");
    expect(h.getSnapshot()).toMatchObject({ results: ["org:b/x"], status: "Exhausted" });
    off();
    c.close();
  });
});
