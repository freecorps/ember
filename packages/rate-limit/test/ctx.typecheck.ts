// The helpers take any query/mutation (sync) or action (async) ctx, and the overloads type the result by which one it
// is: pinned here, since the ctx slices are `unknown`-typed methods. Checked by `tsc -b`, never run.
import type { ActionCtx, MutationCtx, QueryCtx } from "@freecorps/ember-server";
import { RateLimiter, type RateLimitComponentApi, type ReserveResult } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
type Result = { ok: boolean; retryAfter?: number };
declare const api: RateLimitComponentApi;
declare const m: MutationCtx;
declare const q: QueryCtx;
declare const a: ActionCtx;
const l = new RateLimiter(api, { post: { kind: "token bucket", rate: 1, period: 1000 } });

const limitSync = l.limit(m, "post");
const limitAsync = l.limit(a, "post");
const checkSync = l.check(q, "post");
const checkAsync = l.check(a, "post");
const resetSync = l.reset(m, "post");
const resetAsync = l.reset(a, "post");
assert<Equal<typeof limitSync, ReserveResult>>();
assert<Equal<typeof limitAsync, Promise<ReserveResult>>>();
assert<Equal<typeof checkSync, Result>>();
assert<Equal<typeof checkAsync, Promise<Result>>>();
assert<Equal<typeof resetSync, boolean>>();
assert<Equal<typeof resetAsync, Promise<boolean>>>();
