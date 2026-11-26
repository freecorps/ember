// `ClaimsOf<typeof authConfig>` (docs/design/dx.md §3.7): what codegen prints in `_generated/claims.d.ts`. Checked by
// `tsc -b`, never run.
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
