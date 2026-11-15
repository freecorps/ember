// Better Auth organizations in each org shard (PLAN §22 L3) on workerd, with the real Auth Durable Object: every
// organization, member, invitation, team and team member — and the user row of each member — reaches the shard
// `org:<organizationId>` as a read-only `auth:*` table, through the replication outbox of the Auth DO (journaled by
// SQLite triggers in the same transaction as each write). Functions there read them locally (ember/orgs.ts).
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { unsafeRef } from "@freecorps/ember-client";
import type { AuthReplicationStatus } from "@freecorps/ember-runtime";
import { selfFetch, testClient } from "@freecorps/ember-example-testing";
import { describe, expect, it } from "vitest";
import { api } from "../ember/_generated/api";

const BASE = "http://localhost:8787";
const auth = () => env.AUTH.get(env.AUTH.idFromName("auth")) as unknown as {
  replicaStatus(shard?: string): Promise<AuthReplicationStatus>;
  replicaResync(shard: string | null): Promise<{ ok: boolean; targets?: number }>;
  importAuthTables(rows: { tables: Record<string, Record<string, unknown>[]> }): Promise<{ ok: boolean; imported?: Record<string, number>; error?: string }>;
};
const shard = (org: string) => env.SHARD.get(env.SHARD.idFromName(`org:${org}`));

/** `/api/auth/*` with a session token (bearer), as a non-browser client. */
async function call(path: string, o: { token?: string | null; body?: unknown } = {}) {
  const res = await selfFetch(`${BASE}/api/auth${path}`, {
    method: o.body === undefined ? "GET" : "POST",
    headers: { origin: BASE, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return { json, token: res.headers.get("set-auth-token") };
}

let n = 0;
async function signUp(name: string) {
  const email = `${name}-${Date.now()}-${n++}@example.test`.toLowerCase();
  const r = await call("/sign-up/email", { body: { email, password: "correct horse battery staple", name } });
  const token = r.token!;
  return { email, token, id: r.json.user.id as string, jwt: async () => (await call("/token", { token })).json.token as string };
}

/** Runs the Auth DO's alarm until the journal is converted and every target is delivered. */
async function settle(): Promise<AuthReplicationStatus> {
  for (let i = 0; i < 200; i++) {
    await runDurableObjectAlarm(auth() as never);
    const s = await auth().replicaStatus();
    if (s.journal === 0 && s.targets.every((t) => t.pending === 0 && t.snapshot === 0 && t.dead === 0)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`replication did not settle: ${JSON.stringify(await auth().replicaStatus())}`);
}

const overview = (org: string) => {
  const client = testClient();
  return client.query(api.orgs.overview, {}, { shard: `org:${org}` }).finally(() => client.close());
};
/** Raw rows of a replica table in an org shard (what the engine holds, without any function). */
const rows = (org: string, table: string) =>
  runInDurableObject(shard(org), (_i, state) => state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()) as Promise<Array<Record<string, unknown>>>;

/** Better Auth lists invitations only to a verified email: mark it so (this example sends no verification mail). */
const verifyEmail = (userId: string) =>
  runInDurableObject(auth() as never, (_i, state: DurableObjectState) => void state.storage.sql.exec(`UPDATE "user" SET emailVerified = 1 WHERE id = ?`, userId));

/** Invite, then accept as the invitee. */
async function join(owner: { token: string }, org: string, user: { id: string; email: string; token: string }, role = "member") {
  await call("/organization/invite-member", { token: owner.token, body: { email: user.email, role, organizationId: org } });
  await verifyEmail(user.id);
  const inv = (await call("/organization/list-user-invitations", { token: user.token })).json as Array<{ id: string; organizationId: string }>;
  await call("/organization/accept-invitation", { token: user.token, body: { invitationId: inv.find((i) => i.organizationId === org)!.id } });
}

async function createOrg(owner: { token: string }, name: string) {
  const slug = `${name.toLowerCase()}-${Date.now()}-${n++}`;
  return (await call("/organization/create", { token: owner.token, body: { name, slug } })).json as { id: string; slug: string };
}

describe("organizations in the org shard", () => {
  it("create, invite, accept, change role, teams, remove member, delete: the shard follows, a live query gets patches", async () => {
    const ana = await signUp("Ana");
    const org = await createOrg(ana, "Acme");
    await settle();
    expect(await overview(org.id)).toMatchObject({ id: org.id, name: "Acme", members: [{ userId: ana.id, role: "owner", name: "Ana", email: ana.email }], invitations: [] });

    // A live query on the org shard (as the owner): every membership change below is a patch to it.
    const client = testClient({ auth: () => ana.jwt() });
    const seen: Array<{ status: string; value: any }> = [];
    const stop = client.subscribe(api.orgs.overview, {}, { shard: `org:${org.id}` }, (s) => seen.push(s));
    await expect.poll(() => seen.at(-1)?.status).toBe("success");

    const bob = await signUp("Bob");
    await call("/organization/invite-member", { token: ana.token, body: { email: bob.email, role: "member", organizationId: org.id } });
    await settle();
    await expect.poll(() => seen.at(-1)?.value?.invitations).toEqual([{ email: bob.email, role: "member" }]);

    await verifyEmail(bob.id);
    const invitations = (await call("/organization/list-user-invitations", { token: bob.token })).json as Array<{ id: string }>;
    await call("/organization/accept-invitation", { token: bob.token, body: { invitationId: invitations[0]!.id } });
    await settle();
    await expect.poll(() => seen.at(-1)?.value?.members?.length).toBe(2);
    const bobMember = seen.at(-1)!.value.members.find((m: { userId: string }) => m.userId === bob.id);
    expect(bobMember).toMatchObject({ role: "member", name: "Bob", email: bob.email });
    expect(seen.at(-1)!.value.invitations).toEqual([]);

    // Role check from the member's own token: a local read of `auth:member` in the org shard.
    const bobClient = testClient({ auth: () => bob.jwt() });
    expect(await bobClient.query(api.orgs.myRole, {}, { shard: `org:${org.id}` })).toBe("member");
    await call("/organization/update-member-role", { token: ana.token, body: { memberId: bobMember.memberId, role: "admin", organizationId: org.id } });
    await settle();
    await expect.poll(() => bobClient.query(api.orgs.myRole, {}, { shard: `org:${org.id}` })).toBe("admin");

    const team = (await call("/organization/create-team", { token: ana.token, body: { name: "Core", organizationId: org.id } })).json as { id: string };
    await call("/organization/add-team-member", { token: ana.token, body: { teamId: team.id, userId: bob.id } });
    await settle();
    // (Better Auth also creates a default team named after the organization.)
    await expect.poll(() => seen.at(-1)?.value?.teams).toContainEqual({ name: "Core", members: 1 });

    await call("/organization/remove-member", { token: ana.token, body: { memberIdOrEmail: bob.email, organizationId: org.id } });
    await settle();
    await expect.poll(() => seen.at(-1)?.value?.members?.map((m: { userId: string }) => m.userId)).toEqual([ana.id]);
    expect(await bobClient.query(api.orgs.myRole, {}, { shard: `org:${org.id}` })).toBeNull();
    // Bob's user row left the shard with his only membership there.
    expect((await rows(org.id, "auth:user")).map((u) => u.id)).toEqual([ana.id]);

    await call("/organization/delete", { token: ana.token, body: { organizationId: org.id } });
    await settle();
    await expect.poll(() => seen.at(-1)?.value).toBeNull();
    for (const t of ["auth:organization", "auth:member", "auth:invitation", "auth:team", "auth:teamMember", "auth:user"]) expect(await rows(org.id, t)).toEqual([]);
    stop();
    client.close();
    bobClient.close();
  });

  it("a user's update reaches every org shard the user belongs to; hidden fields never leave the Auth DO", async () => {
    const cleo = await signUp("Cleo");
    const a = await createOrg(cleo, "Alpha");
    const b = await createOrg(cleo, "Beta");
    await settle();
    await call("/update-user", { token: cleo.token, body: { name: "Cleo Renamed" } });
    await settle();
    for (const org of [a, b]) expect((await overview(org.id))?.members).toEqual([expect.objectContaining({ userId: cleo.id, name: "Cleo Renamed" })]);
    const [user] = await rows(a.id, "auth:user");
    expect(JSON.stringify(user)).not.toMatch(/password|token/i);
  });

  it("app code cannot write replica tables (ReadOnlyTable)", async () => {
    const dan = await signUp("Dan");
    const org = await createOrg(dan, "Delta");
    await settle();
    const client = testClient({ auth: () => dan.jwt() });
    await expect(client.mutation(unsafeRef<"mutation">("testing:writeMember"), {}, { shard: `org:${org.id}` })).rejects.toMatchObject({ code: "ReadOnlyTable" });
    client.close();
  });

  it("crash safety: a write whose request never finished (no alarm armed) is recovered from the journal on the next start", async () => {
    const eve = await signUp("Eve");
    const fay = await signUp("Fay");
    const org = await createOrg(eve, "Echo");
    await settle();
    // Written straight into SQLite (around Better Auth, as a crash right after the commit would leave it): only the
    // triggers saw it, and no alarm is armed.
    await runInDurableObject(auth() as never, async (_i, state: DurableObjectState) => {
      state.storage.sql.exec(`INSERT INTO "member" (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)`, `mem_${n++}`, org.id, fay.id, new Date().toISOString());
      await state.storage.deleteAlarm();
    });
    evictDurableObject(auth() as never);
    // The next start (any request) sees the journal and arms the alarm.
    await auth().replicaStatus();
    await settle();
    expect((await overview(org.id))?.members.map((m) => m.userId).sort()).toEqual([eve.id, fay.id].sort());
  });

  it("a shard that lost its replica (gap) is resynced, and converges with writes made meanwhile", async () => {
    const gus = await signUp("Gus");
    const hal = await signUp("Hal");
    const org = await createOrg(gus, "Golf");
    await join(gus, org.id, hal);
    await settle();
    // The shard loses its rows and its high-water mark (e.g. a restore to an earlier point).
    await runInDurableObject(shard(org.id), (_i, state) => {
      state.storage.sql.exec(`DELETE FROM "_ember_replicas"`);
      state.storage.sql.exec(`DELETE FROM "auth:member"`);
    });
    // Writes made while the shard is behind: the next delivery reveals the gap, the source resyncs the shard, and the
    // deltas after the resync's cut apply on top.
    const ivy = await signUp("Ivy");
    const halMember = ((await call(`/organization/get-full-organization?organizationId=${org.id}`, { token: gus.token })).json.members as Array<{ id: string; userId: string }>).find((m) => m.userId === hal.id)!;
    await call("/organization/update-member-role", { token: gus.token, body: { memberId: halMember.id, role: "admin", organizationId: org.id } });
    await runDurableObjectAlarm(auth() as never);
    await call("/organization/invite-member", { token: gus.token, body: { email: ivy.email, role: "member", organizationId: org.id } });
    await settle();
    const o = await overview(org.id);
    expect(o?.members.map((m) => [m.userId, m.role]).sort()).toEqual([[gus.id, "owner"], [hal.id, "admin"]].sort());
    expect(o?.invitations).toEqual([{ email: ivy.email, role: "member" }]);
  });

  it("bootstrap: replication enabled after organizations exist resyncs every one of them; the admin endpoint resyncs one", async () => {
    const jo = await signUp("Jo");
    const org = await createOrg(jo, "Juliet");
    await settle();
    await runInDurableObject(shard(org.id), (_i, state) => {
      for (const t of ["_ember_replicas", "auth:member", "auth:organization", "auth:user"]) state.storage.sql.exec(`DELETE FROM "${t}"`);
    });
    // As if `ember.replicate` had just been turned on: the Auth DO has no record of a previous bootstrap.
    await runInDurableObject(auth() as never, (_i, state: DurableObjectState) => void state.storage.sql.exec(`DELETE FROM _ember_replication_meta`));
    evictDurableObject(auth() as never);
    await auth().replicaStatus();
    await settle();
    expect(await overview(org.id)).toMatchObject({ name: "Juliet", members: [{ userId: jo.id, role: "owner", name: "Jo" }] });

    // Admin: state of one target, then a resync of it.
    const admin = (path: string, init?: RequestInit) => selfFetch(`${BASE}/api/_ember/${path}`, { ...init, headers: { authorization: "Bearer admin-secret", "content-type": "application/json" } });
    const status = (await (await admin(`replicas?shard=org:${org.id}`)).json()) as any;
    expect(status).toMatchObject({ ok: true, sources: { auth: { enabled: true, targets: [{ target: `org:${org.id}`, pending: 0, dead: 0 }] } } });
    expect(status.tables.map((t: { name: string }) => t.name)).toContain("auth:member");
    await runInDurableObject(shard(org.id), (_i, state) => void state.storage.sql.exec(`DELETE FROM "auth:organization"`));
    expect(await (await admin("replicas/resync", { method: "POST", body: JSON.stringify({ shard: `org:${org.id}` }) })).json()).toEqual({ ok: true, value: { auth: { ok: true, targets: 1 } } });
    await settle();
    expect((await rows(org.id, "auth:organization")).map((r) => r.name)).toEqual(["Juliet"]);
    expect((await admin("replicas/resync", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });

  it("importAuthTables: imported users, organizations and members reach the org shard", async () => {
    const at = new Date().toISOString();
    const u = `usr_imp_${n++}`;
    const o = `org_imp_${n++}`;
    const r = await auth().importAuthTables({
      tables: {
        member: [{ id: `mem_imp_${n++}`, organizationId: o, userId: u, role: "owner", createdAt: at }],
        user: [{ id: u, email: `${u}@example.test`, name: "Imported", emailVerified: 1, createdAt: at, updatedAt: at }],
        organization: [{ id: o, name: "Imported Org", slug: `imported-${n++}`, createdAt: at }],
      },
    });
    expect(r).toEqual({ ok: true, imported: { user: 1, organization: 1, member: 1 }, skipped: 0 });
    await settle();
    expect(await overview(o)).toMatchObject({ name: "Imported Org", members: [{ userId: u, role: "owner", name: "Imported" }] });
    expect(await auth().importAuthTables({ tables: { nope: [] } })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown auth table/) });
  });
});
