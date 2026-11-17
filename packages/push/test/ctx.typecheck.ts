// `PushNotifications` takes any query/mutation (sync) or action (async) ctx, and the overloads type the result by which
// one it is: pinned here, since the ctx slices are `unknown`-typed methods. Checked by `tsc -b`, never run.
import type { ActionCtx, MutationCtx, QueryCtx } from "@freecorps/ember-server";
import { PushNotifications, type DeliveryResult, type PushComponentApi, type PushDevice } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
declare const api: PushComponentApi;
declare const m: MutationCtx;
declare const q: QueryCtx;
declare const a: ActionCtx;
const push = new PushNotifications(api);

const registerSync = push.register(m, { userId: "u", token: "t" });
const registerAsync = push.register(a, { userId: "u", token: "t" });
const devicesSync = push.devices(q, "u");
const devicesAsync = push.devices(a, "u");
const sendSync = push.send(m, ["u"], { title: "hi" });
const sendAsync = push.send(a, ["u"], { title: "hi" });
const sendNow = push.sendNow(a, ["u"], { title: "hi" });
assert<Equal<typeof registerSync, string>>();
assert<Equal<typeof registerAsync, Promise<string>>>();
assert<Equal<typeof devicesSync, PushDevice[]>>();
assert<Equal<typeof devicesAsync, Promise<PushDevice[]>>>();
assert<Equal<typeof sendSync, string>>();
assert<Equal<typeof sendAsync, Promise<string>>>();
assert<Equal<typeof sendNow, Promise<DeliveryResult>>>();
