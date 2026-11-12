// Drift check (docs/design/dx.md §3.7): the documented `EmailComponentApi` (hand-written, with named types) must match
// what the component's functions really take. Checked by `tsc -b`, never run.
import type { ComponentApi } from "@freecorps/ember-server";
import type { email } from "../src/component.ts";
import type { EmailComponentApi } from "../src/client.ts";

type Derived = ComponentApi<typeof email>["lib"];
type Hand = EmailComponentApi["lib"];
const assert = <T extends true>() => {};
type IsNever<T> = [T] extends [never] ? true : false;

/** Documented functions that do not exist (or are not public). */
export type Missing = Exclude<keyof Hand, keyof Derived>;
assert<IsNever<Missing>>();

/** Ids are documented as plain strings (callers pass what earlier results gave them): compare them as strings. */
type Widen<T> = T extends string ? string : T extends readonly (infer U)[] ? Widen<U>[] : T extends object ? { [K in keyof T]: Widen<T[K]> } : T;
/** Functions whose documented args differ from the validators (either way). */
export type ArgsDrift = {
  [K in keyof Hand & keyof Derived]: [Widen<Derived[K]["_args"]>] extends [Widen<Hand[K]["_args"]>] ? ([Widen<Hand[K]["_args"]>] extends [Widen<Derived[K]["_args"]>] ? never : K) : K;
}[keyof Hand & keyof Derived];
assert<IsNever<ArgsDrift>>();

/** Functions whose kind (query / mutation / action) differs. */
export type KindDrift = { [K in keyof Hand & keyof Derived]: Hand[K]["_type"] extends Derived[K]["_type"] ? never : K }[keyof Hand & keyof Derived];
assert<IsNever<KindDrift>>();
