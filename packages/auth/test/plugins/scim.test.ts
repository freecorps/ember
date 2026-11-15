/**
 * scim: a directory provisions and deprovisions users and group membership with a bearer token. The app's projection
 * (auth.config.ts) turns groups into organization roles; deprovisioning ends the user's sessions in the SCIM
 * transaction and their Ember sockets right after (`revokeSockets` by subject).
 */
import { describe, expect, it } from "vitest";
import { magicLinks, SCIM_ORG_SLUG } from "./auth.config.ts";
import { Client, jwtOf, query, rnd, signedUp, socket, until, whoami } from "./helpers.ts";

const TOKEN = "scim-test-token-0123456789";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const scim = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) =>
  new Client().req(`/api/auth/scim/v2${path}`, {
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
    headers: init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` },
  });

async function signInByMagicLink(email: string) {
  const c = new Client();
  expect((await c.req("/api/auth/sign-in/magic-link", { body: { email, callbackURL: "/" } })).status).toBe(200);
  const link = magicLinks.findLast((m) => m.email === email)!;
  expect((await c.req(`/api/auth/magic-link/verify?token=${link.token}&callbackURL=/`)).status).toBeLessThan(400);
  return c;
}

describe("scim", () => {
  it("refuses requests without the connection's bearer token", async () => {
    expect((await scim("/Users", { token: null })).status).toBe(401);
    expect((await scim("/Users", { token: "wrong-token-0123456789" })).status).toBe(401);
    expect((await scim("/ServiceProviderConfig")).status).toBe(200);
  });

  it("provision a user, grant a role through a group, deprovision: membership, sessions and sockets follow", async () => {
    const admin = await signedUp("scim-admin", "Admin");
    const org = await admin.c.req("/api/auth/organization/create", { body: { name: "Directory Org", slug: SCIM_ORG_SLUG } });
    expect(org.status, org.text).toBe(200);
    const members = async () =>
      ((await admin.c.req(`/api/auth/organization/get-full-organization?organizationId=${org.json.id}`)).json.members as { user: { email: string }; role: string }[]).map((m) => [m.user.email, m.role]);

    // Provision.
    const email = `jdoe-${rnd()}@directory.test`;
    const created = await scim("/Users", {
      body: { schemas: [USER], userName: email, externalId: `ext-${rnd()}`, name: { givenName: "Jane", familyName: "Doe" }, emails: [{ value: email, primary: true }], active: true },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.headers.get("content-type")).toContain("application/scim+json");
    const scimUserId = created.json.id as string;
    expect((await scim(`/Users/${scimUserId}`)).json).toMatchObject({ userName: email, active: true });

    // Group → role in the org (the app's projection, inside the SCIM transaction).
    const group = await scim("/Groups", { body: { schemas: [GROUP], displayName: "Engineers", members: [{ value: scimUserId }] } });
    expect(group.status, group.text).toBe(201);
    expect(await members()).toContainEqual([email, "member"]);
    const admins = await scim("/Groups", { body: { schemas: [GROUP], displayName: "Admins", members: [] } });
    expect(admins.status, admins.text).toBe(201);
    const promote = await scim(`/Groups/${admins.json.id}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "add", path: "members", value: [{ value: scimUserId }] }] } });
    expect(promote.status, promote.text).toBeLessThan(300);
    expect(await members()).toContainEqual([email, "admin"]);

    // The provisioned user signs in (here by magic link) and is an ordinary Ember identity.
    const browser = await signInByMagicLink(email);
    const jwt = await jwtOf(browser);
    const userId = (await whoami(jwt))!.subject;
    const ws = await socket(jwt);

    // The profile outbox delivered the provisioned user to the app shard; no hidden field went along. SCIM writes the
    // user with the adapter, around `databaseHooks`: its `create` comes from the journal recovery (after the grace
    // period), so it can arrive after the `update` of the first sign-in. Both carry the current row: `users.sync`
    // must upsert.
    const profiles = await until(async () => (await query("app:profiles", { userId })).body.value as { event: string; fields: string[]; user: { email: string } }[], (p) => p.some((x) => x.event === "create"));
    expect(profiles.map((p) => p.event)).toEqual(expect.arrayContaining(["create", "update"]));
    for (const p of profiles) {
      expect(p.user.email).toBe(email);
      expect(p.fields).toEqual(expect.arrayContaining(["id", "email", "name"]));
      expect(p.fields.filter((f) => /password|secret|token/i.test(f))).toEqual([]);
    }

    // Deprovision: deactivated in the directory.
    const off = await scim(`/Users/${scimUserId}`, { method: "PATCH", body: { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: false }] } });
    expect(off.status, off.text).toBeLessThan(300);
    expect((await members()).map(([e]) => e)).not.toContain(email);
    expect((await browser.req("/api/auth/get-session?disableCookieCache=true")).json).toBeNull();
    await ws.waitFor("authExpired");
    expect((await query("app:whoami", {}, jwt)).body).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    ws.close();

    // Delete in the directory: the SCIM resource is gone.
    expect((await scim(`/Users/${scimUserId}`, { method: "DELETE" })).status).toBe(204);
    expect((await scim(`/Users/${scimUserId}`)).status).toBe(404);
  });
});
