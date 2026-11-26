// Typed identity claims (docs/design/dx.md §3.7): `Identity<Claims>` in `ctx.auth`, and `fromAuth` names a declared
// claim. `_generated/server.d.ts` passes the app's claims as the builders' last type argument. Checked by `tsc -b`.
import { fromAuth, v, type ActionAuth, type ActionBuilder, type ActionCtx, type AnyDataModel, type Auth, type ClaimName, type FromAuth, type Identity, type MutationBuilder, type QueryBuilder, type ShardDef } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
type Claims = { sid: string; email: string; org?: string; role?: "admin" | "member" };

declare const query: QueryBuilder<AnyDataModel, "public", {}, {}, readonly [], Claims>;
declare const mutation: MutationBuilder<AnyDataModel, "public", {}, {}, readonly [], Claims>;
declare const action: ActionBuilder<"public", AnyDataModel, {}, {}, readonly [], Claims>;
/** What `_generated/server` exports. */
declare const typedFromAuth: <const C extends "sid" | "email" | "org" | "role">(claim: C) => FromAuth<C>;

export const q = query({
  handler: (ctx) => {
    const me = ctx.auth.require();
    assert<Equal<typeof me, Identity<Claims>>>();
    assert<Equal<NonNullable<typeof me.claims>["role"], "admin" | "member" | undefined>>();
    // @ts-expect-error not a declared claim
    void me.claims?.nope;
    return me.claims?.email ?? null;
  },
});

export const m = mutation({
  shard: { org: fromAuth("org") },
  handler: (ctx) => ctx.auth.getUserIdentity()?.claims?.org,
});

export const mTyped = mutation({ shard: { org: typedFromAuth("org") }, handler: () => null });
// @ts-expect-error a claim the app does not declare
typedFromAuth("tenant");

// @ts-expect-error fromAuth names an undeclared claim: the shard is refused by the builder too
export const bad = mutation({ shard: { org: fromAuth("tenant") }, handler: () => null });
// Why: `FromAuth` is covariant in its name (a readonly field), and the builder's shard takes `FromAuth<ClaimName<Claims>>`
// (the declared names), so another name is not assignable; with undeclared claims any name is.
assert<Equal<ClaimName<Claims>, "sid" | "email" | "org" | "role">>();
assert<Equal<FromAuth<"tenant"> extends FromAuth<ClaimName<Claims>> ? true : false, false>>();
assert<Equal<{ org: FromAuth<"tenant"> } extends ShardDef<{}, Claims> ? true : false, false>>();
assert<Equal<{ org: FromAuth<"org"> } extends ShardDef<{}, Claims> ? true : false, true>>();
assert<Equal<{ org: FromAuth<"tenant"> } extends ShardDef<{}> ? true : false, true>>();
// An index signature in the declared claims says any name may be one.
assert<Equal<ClaimName<{ tenant?: string; [k: string]: unknown }>, string>>();

export const a = action({
  args: { x: v.number() },
  handler: async (ctx) => {
    const me = await ctx.auth.require();
    assert<Equal<typeof me, Identity<Claims>>>();
    // `ActionAuth` (and `Auth`) are part of the package's surface.
    assert<Equal<typeof ctx.auth, ActionAuth<Claims>>>();
    return me.subject;
  },
});

// Middlewares keep the claims.
export const withUser = mutation.use((ctx) => ({ ctx: { me: ctx.auth.require() } }));
export const viaMw = withUser((ctx) => {
  assert<Equal<typeof ctx.me, Identity<Claims>>>();
  return ctx.auth.require().claims?.sid;
});

// Without declared claims (the generic builders): any name, `unknown` values.
declare const anyQuery: QueryBuilder<AnyDataModel, "public">;
export const loose = anyQuery({
  shard: { t: fromAuth("whatever") },
  handler: (ctx) => {
    const claims = ctx.auth.getUserIdentity()?.claims;
    assert<Equal<typeof claims, Record<string, unknown> | undefined>>();
    return null;
  },
});

// The public auth types of the contexts, by name.
assert<Equal<ActionCtx<AnyDataModel, Claims>["auth"], ActionAuth<Claims>>>();
assert<Equal<ReturnType<Auth<Claims>["require"]>, Identity<Claims>>>();
assert<Equal<ReturnType<ActionAuth["require"]>, Promise<Identity<Record<string, unknown>>>>>();
