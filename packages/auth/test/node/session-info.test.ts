/**
 * `toSessionInfo` reads a Better Auth session body that `remoteAuth` gets from another origin (`get-session`): a
 * malformed one is no session, never an identity with an undefined subject or a NaN expiry.
 */
import { describe, expect, it } from "vitest";
import { toSessionInfo } from "../../src/verify-core.ts";

const exp = "2030-01-01T00:00:00.000Z";

describe("toSessionInfo", () => {
  it("maps a well-formed session", () => {
    expect(
      toSessionInfo({
        session: { id: "s1", expiresAt: exp, activeOrganizationId: "org1" },
        user: { id: "u1", email: "a@x.dev", name: "Ana", emailVerified: true },
      }),
    ).toEqual({ userId: "u1", sessionId: "s1", expiresAt: Date.parse(exp), email: "a@x.dev", name: "Ana", emailVerified: true, org: "org1" });
    // Date and ms expiries (the session rows), no email/name: omitted, not undefined strings.
    const d = toSessionInfo({ session: { id: "s1", expiresAt: new Date(exp) }, user: { id: "u1" } });
    expect(d).toEqual({ userId: "u1", sessionId: "s1", expiresAt: Date.parse(exp), emailVerified: false, org: null });
    expect(d && "email" in d).toBe(false);
    expect(toSessionInfo({ session: { id: "s1", expiresAt: Date.parse(exp) }, user: { id: "u1" } })?.expiresAt).toBe(Date.parse(exp));
  });

  it.each([
    ["null", null],
    ["a string", "nope"],
    ["no user", { session: { id: "s1", expiresAt: exp } }],
    ["no session", { user: { id: "u1" } }],
    ["user.id missing", { session: { id: "s1", expiresAt: exp }, user: {} }],
    ["user.id empty", { session: { id: "s1", expiresAt: exp }, user: { id: "" } }],
    ["user.id a number", { session: { id: "s1", expiresAt: exp }, user: { id: 7 } }],
    ["session.id missing", { session: { expiresAt: exp }, user: { id: "u1" } }],
    ["expiresAt missing", { session: { id: "s1" }, user: { id: "u1" } }],
    ["expiresAt invalid", { session: { id: "s1", expiresAt: "soon" }, user: { id: "u1" } }],
    ["expiresAt an object", { session: { id: "s1", expiresAt: {} }, user: { id: "u1" } }],
  ])("%s → null", (_, body) => {
    expect(toSessionInfo(body)).toBeNull();
  });

  it("keeps email and name only when they are strings", () => {
    const s = toSessionInfo({ session: { id: "s1", expiresAt: exp }, user: { id: "u1", email: 3, name: null } });
    expect(s && ("email" in s || "name" in s)).toBe(false);
  });
});
