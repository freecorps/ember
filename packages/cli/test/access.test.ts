import { describe, expect, it } from "vitest";
import { ensureAccessApp } from "../src/access.ts";

function fakeClient(o: { org?: string | null; apps?: Array<{ id: string; aud: string; domain: string; name: string }> }) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const client = {
    accountId: "acc",
    request: async (method: string, path: string) => {
      calls.push({ method, path });
      return o.org ? { success: true, result: { auth_domain: o.org } } : { success: false, errors: [{ code: 10000, message: "Authentication error" }] };
    },
    call: async (method: string, path: string, body?: any) => {
      calls.push({ method, path, ...(body ? { body } : {}) });
      if (method === "GET") return o.apps ?? [];
      if (path === "/access/apps") return { id: "app1", aud: "aud-123", domain: body.domain, name: body.name };
      return { id: "pol1" };
    },
  } as any;
  return { client, calls };
}

describe("ember dashboard deploy --access", () => {
  it("creates a self-hosted app with an allow policy and returns its AUD and team domain", async () => {
    const { client, calls } = fakeClient({ org: "acme.cloudflareaccess.com" });
    const app = await ensureAccessApp(client, { host: "ember-dashboard.acme.workers.dev", name: "ember-dashboard", emails: ["ops@acme.test"], emailDomains: ["acme.test"] });
    expect(app).toEqual({ id: "app1", aud: "aud-123", team: "acme.cloudflareaccess.com", created: true });
    expect(calls.find((c) => c.path === "/access/apps" && c.method === "POST")?.body).toMatchObject({ type: "self_hosted", domain: "ember-dashboard.acme.workers.dev", app_launcher_visible: false });
    expect(calls.find((c) => c.path === "/access/apps/app1/policies")?.body).toMatchObject({ decision: "allow", include: [{ email: { email: "ops@acme.test" } }, { email_domain: { domain: "acme.test" } }] });
  });

  it("reuses the app already protecting the host; needs --access-team when the org cannot be read", async () => {
    const apps = [{ id: "a9", aud: "aud-9", domain: "dash.acme.test", name: "Dashboard" }];
    const { client, calls } = fakeClient({ org: null, apps });
    await expect(ensureAccessApp(client, { host: "dash.acme.test", name: "ember-dashboard" })).rejects.toThrow(/--access-team/);
    const app = await ensureAccessApp(client, { host: "dash.acme.test", name: "ember-dashboard", team: "https://acme.cloudflareaccess.com/" });
    expect(app).toEqual({ id: "a9", aud: "aud-9", team: "acme.cloudflareaccess.com", created: false });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const { client: c2 } = fakeClient({ org: "acme.cloudflareaccess.com" });
    await expect(ensureAccessApp(c2, { host: "new.acme.test", name: "x" })).rejects.toThrow(/--access-email/);
  });
});
