// Typed identity claims (docs/design/dx.md §3.7): `Identity<Claims>` in `ctx.auth`, and `fromAuth` names a declared
// claim. `_generated/server.d.ts` passes the app's claims as the builders' last type argument. Checked by `tsc -b`.
import { fromAuth, v, type ActionBuilder, type AnyDataModel, type FromAuth, type Identity, type MutationBuilder, type QueryBuilder } from "../src/index.ts";

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

export const a = action({
  args: { x: v.number() },
  handler: async (ctx) => {
    const me = await ctx.auth.require();
    assert<Equal<typeof me, Identity<Claims>>>();
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
