// Profile sync off with the real Auth Durable Object: this app has auth and no `users:sync`, and its Auth DO is wrapped
// by the outbox (as the generated entry always does), so the user-table triggers journal every write. Nothing reads
// that journal: the hook and the alarm drop it, and the object goes quiet (no alarm left, none firing), in both forms
// of the class (`emberAuth`, and `emberAuthLazy`, which the generated entry uses), with organization replication on.
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authAlarms } from "./worker";

const BASE = "http://localhost:8787";
const PASSWORD = "correct horse battery staple";
type Stub = DurableObjectStub;

/** `/api/auth/*` straight to one Auth object (a bearer session token, as a non-browser client). */
async function call(stub: Stub, path: string, o: { token?: string; body?: unknown } = {}) {
  const res = await stub.fetch(
    new Request(`${BASE}/api/auth${path}`, {
      method: o.body === undefined ? "GET" : "POST",
      headers: { origin: BASE, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    }),
  );
  const json = (await res.json().catch(() => null)) as { user?: { id: string } } | null;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return { id: json?.user?.id as string, token: res.headers.get("set-auth-token")! };
}

const inside = <T,>(stub: Stub, f: (s: DurableObjectStorage) => T | Promise<T>) => runInDurableObject(stub, (_i, state) => f(state.storage)) as Promise<T>;
const journal = (stub: Stub) => inside(stub, (s) => s.sql.exec(`SELECT seq FROM "_ember_user_journal"`).toArray().length);
const outbox = (stub: Stub) =>
  inside(stub, (s) => (s.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = '_ember_outbox'`).toArray().length ? s.sql.exec(`SELECT seq FROM "_ember_outbox"`).toArray().length : 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs whatever alarm is scheduled (the crash-gap check arms one a grace period out), then makes sure the object is
 * quiet: a 300 ms window with no alarm run (one already dispatched by workerd may still land in the first) and no
 * alarm scheduled. An alarm that re-arms itself for a row that never leaves runs in every window and fails here.
 */
async function settlesQuiet(stub: Stub) {
  for (let i = 0; i < 5 && (await runDurableObjectAlarm(stub)); i++);
  const runs = () => authAlarms.get(stub.id.toString()) ?? 0;
  let idle = false;
  for (let w = 0; w < 4 && !idle; w++) {
    const before = runs();
    await sleep(300);
    idle = runs() === before;
  }
  expect(idle, `the alarm keeps running (${runs()} runs)`).toBe(true);
  expect(await inside(stub, (s) => s.getAlarm())).toBeNull();
  expect(await journal(stub)).toBe(0);
  expect(await outbox(stub)).toBe(0);
}

let n = 0;
const fresh = (ns: DurableObjectNamespace) => ns.get(ns.idFromName(`sync-off-${Date.now()}-${n++}`));
const email = () => `quiet-${Date.now()}-${n++}@example.test`;

describe.each([
  ["emberAuth", () => env.AUTH],
  ["emberAuthLazy", () => env.AUTH_LAZY],
])("profile sync off, real Auth object (%s)", (_name, ns) => {
  it("sign-up, update and delete leave no journal and no alarm", async () => {
    const stub = fresh(ns());
    const { token } = await call(stub, "/sign-up/email", { body: { email: email(), password: PASSWORD, name: "Quiet" } });
    // The hook ran and had nothing to send: the trigger's journal row went with it.
    expect(await journal(stub)).toBe(0);
    await call(stub, "/update-user", { token, body: { name: "Quieter" } });
    expect(await journal(stub)).toBe(0);
    await settlesQuiet(stub);
    await call(stub, "/delete-user", { token, body: { password: PASSWORD } });
    expect(await journal(stub)).toBe(0);
    await settlesQuiet(stub);
  });

  it("an object from before the fix (a backlog of journal rows, an alarm armed) drops them and stops", async () => {
    const stub = fresh(ns());
    const { id } = await call(stub, "/sign-up/email", { body: { email: email(), password: PASSWORD, name: "Old" } });
    // The first alarm (replication bootstrap, armed for now) must not run in the middle of the setup below.
    await settlesQuiet(stub);
    // What 0.8.0 left behind: user writes journaled and never consumed (written around the hook here, so the triggers
    // run and nothing drops the rows), long past the grace period, and an alarm armed for them (a minute out, so it is
    // this test that runs it, not workerd before the rows are checked).
    await inside(stub, async (s) => {
      for (let i = 0; i < 500; i++) s.sql.exec(`UPDATE "user" SET "name" = ? WHERE "id" = ?`, `Old ${i}`, id);
      s.sql.exec(`UPDATE "_ember_user_journal" SET "at" = "at" - 86400000`);
      await s.setAlarm(Date.now() + 60_000);
    });
    expect(await journal(stub)).toBe(500);
    // The object restarts on this code with that alarm scheduled.
    await evictDurableObject(stub);
    await settlesQuiet(stub);

    // Rows and no alarm: the next activation arms one (the crash-gap check), which drops them and does not come back.
    await inside(stub, (s) => s.sql.exec(`UPDATE "user" SET "name" = 'Again' WHERE "id" = ?`, id));
    await evictDurableObject(stub);
    expect(await inside(stub, (s) => s.getAlarm())).not.toBeNull();
    await settlesQuiet(stub);
  });
});
