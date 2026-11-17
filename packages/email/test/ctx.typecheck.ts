// `Email` takes any query/mutation (sync) or action (async) ctx, and the overloads type the result: pinned here, since
// the ctx slices are `unknown`-typed methods. Checked by `tsc -b`, never run.
import type { ActionCtx, MutationCtx, QueryCtx } from "@freecorps/ember-server";
import { Email, type EmailComponentApi, type EmailRecord, type EmailStatus, type SendInput, type SendResult } from "../src/index.ts";

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
// An action ctx (it has `runAction`) takes the async overloads: what these calls return at run time.
const fromAction = mail.send(a, input);
const gotFromAction = mail.get(a, "id");
assert<Equal<typeof fromAction, Promise<SendResult>>>();
assert<Equal<typeof gotFromAction, Promise<EmailRecord | null>>>();
// A hand-made synchronous adapter and an untyped ctx still take the sync ones, as before.
const fromAdapter = mail.get({ runQuery: () => null }, "id");
declare const untyped: any;
const fromAny = mail.send(untyped, input);
assert<Equal<typeof fromAdapter, EmailRecord | null>>();
assert<Equal<typeof fromAny, SendResult>>();
// `status` is synchronous only (it reads the record's field at once): an action ctx, whose `runQuery` returns a
// Promise, is a type error instead of a silent `null`.
const st = mail.status(q, "id");
assert<Equal<typeof st, EmailStatus | null>>();
// @ts-expect-error an action ctx has `runAction`
mail.status(a, "id");
