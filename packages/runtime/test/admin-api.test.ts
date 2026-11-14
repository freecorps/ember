// Admin endpoints added for the Ember Dashboard (admin-api.ts; docs/design/contracts.md "Dashboard").
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_API_LEVEL, ADMIN_FEATURES } from "../src/admin-api.ts";

const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = "admin-secret", ...rest } = init;
  return SELF.fetch(`http://ember${path}`, { ...rest, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers as Record<string, string> | undefined) } });
};

describe("GET /api/_ember/capabilities", () => {
  it("lists the admin endpoints this runtime serves, behind the admin token", async () => {
    expect((await call("/api/_ember/capabilities", { token: null })).status).toBe(401);
    expect((await call("/api/_ember/capabilities", { token: "nope" })).status).toBe(401);
    const res = await call("/api/_ember/capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; level: number; features: string[]; system: boolean };
    expect(body).toMatchObject({ ok: true, level: ADMIN_API_LEVEL, system: true });
    expect(body.features).toEqual([...ADMIN_FEATURES]);
    expect((await call("/api/_ember/capabilities", { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("every listed GET feature answers (no listed endpoint is a 404)", async () => {
    for (const f of ["status", "data", "crons", "inspect", "bookmarks"]) {
      const res = await call(`/api/_ember/${f}?shard=global:main`);
      expect([f, res.status]).toEqual([f, 200]);
    }
    // An unknown admin path is the generic 404 the dashboard maps to "update the runtime".
    const res = await call("/api/_ember/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: { code: "not_found", message: "not found" } });
  });
});
