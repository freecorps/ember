// `Email` takes any query/mutation (sync) or action (async) ctx, and the overloads type the result: pinned here, since
// the ctx slices are `unknown`-typed methods. Checked by `tsc -b`, never run.
import type { ActionCtx, MutationCtx, QueryCtx } from "@freecorps/ember-server";
import { Email, type EmailComponentApi, type EmailRecord, type SendInput, type SendResult } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
declare const api: EmailComponentApi;
declare const m: MutationCtx;
declare const q: QueryCtx;
declare const a: ActionCtx;
declare const input: SendInput;
const mail = new Email(api);

const sent = mail.send(m, input);
const batch = mail.sendBatch(m, [input]);
const got = mail.get(q, "id");
const canceled = mail.cancel(m, "id");
assert<Equal<typeof sent, SendResult>>();
assert<Equal<typeof batch, SendResult[]>>();
assert<Equal<typeof got, EmailRecord | null>>();
assert<Equal<typeof canceled, { ok: boolean; status: string }>>();
// Unchanged from before the any cleanup: `SyncCtx` has no `db`, so an action ctx also matches the first (sync)
// overload. Kept as is here (a typing change for callers); see the PR that removed the explicit any.
const fromAction = mail.send(a, input);
assert<Equal<typeof fromAction, SendResult>>();
