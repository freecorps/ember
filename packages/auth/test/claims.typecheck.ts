// `ClaimsOf<typeof authConfig>` (docs/design/dx.md §3.7): what codegen prints in `_generated/claims.d.ts`. Checked by
// `tsc -b`, never run.
import type { BetterAuthPlugin } from "better-auth";
import { organization } from "better-auth/plugins";
import { defineAuth, type ClaimsOf, type SessionClaims } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
type Session = { sid: string; email: string; name: string; emailVerified: boolean };

// Better Auth's claims, always there.
const plain = defineAuth({ emailAndPassword: { enabled: true } });
assert<Equal<ClaimsOf<typeof plain>, Session>>();

// The organization plugin adds the active organization; `ember.claims` adds its own, optional (only JWTs carry them).
const full = defineAuth({
  plugins: [organization()],
  ember: { claims: (s) => ({ role: (s.user.role === "admin" ? "admin" : "member") as "admin" | "member", plan: 1 }) },
});
type Full = ClaimsOf<typeof full>;
assert<Equal<Full["org"], string | undefined>>();
assert<Equal<Full["role"], "admin" | "member" | undefined>>();
assert<Equal<keyof Full, "sid" | "email" | "name" | "emailVerified" | "org" | "role" | "plan">>();
assert<Equal<Full["plan"], number | undefined>>();
assert<Equal<Full["email"], string>>();

// The function form and an async `ember.claims`.
const factory = defineAuth(() => ({ ember: { claims: async () => ({ tenant: "t" as string }) } }));
assert<Equal<keyof ClaimsOf<typeof factory>, "sid" | "email" | "name" | "emailVerified" | "tenant">>();
assert<Equal<ClaimsOf<typeof factory>["tenant"], string | undefined>>();

// Something that is not a defineAuth value: the session claims.
assert<Equal<ClaimsOf<{ emailAndPassword: { enabled: true } }>, SessionClaims>>();

// A plugin list that is not a literal tuple: the organization plugin is still seen (by its id, or because a widened
// plugin's id says nothing), so `org` stays a claim.
const orgPlugins = [organization()];
const fromVariable = defineAuth({ plugins: orgPlugins });
assert<Equal<ClaimsOf<typeof fromVariable>["org"], string | undefined>>();
const widened: BetterAuthPlugin[] = [organization() as unknown as BetterAuthPlugin];
const fromWidened = defineAuth({ plugins: widened });
assert<Equal<keyof ClaimsOf<typeof fromWidened>, keyof Session | "org">>();
// Plugins whose ids are known and none is the organization one: no `org`.
const noOrg = defineAuth({ plugins: [{ id: "custom" as const }] });
assert<Equal<keyof ClaimsOf<typeof noOrg>, keyof Session>>();

// A custom claim reusing a built-in name replaces it in the JWT (spread last): the name is typed as either value,
// never as an impossible intersection.
const overriding = defineAuth({ plugins: [organization()], ember: { claims: () => ({ email: 123 as number, org: 7 as number, extra: true as boolean }) } });
type Over = ClaimsOf<typeof overriding>;
assert<Equal<Over["email"], string | number>>();
assert<Equal<Over["org"], string | number | undefined>>();
assert<Equal<Over["extra"], boolean | undefined>>();
assert<Equal<Over["sid"], string>>();

// `ember.claims` typed as a plain record: the built-in claims keep their types, any other name is `unknown`.
const record = defineAuth({ ember: { claims: (): Record<string, unknown> => ({}) } });
type Rec = ClaimsOf<typeof record>;
assert<Equal<Rec["sid"], string>>();
assert<Equal<Rec["anything"], unknown>>();
