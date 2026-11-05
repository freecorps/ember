import { describe, expect, it } from "vitest";
import { generations, planRotation, rotateKeys } from "../src/keys.ts";

describe("key rotation by secret generation", () => {
  it("plans the next generation and drops the ones older than the current", () => {
    expect(planRotation(["EMBER_ADMIN_TOKEN"], "EMBER_STORAGE_SECRET")).toEqual({ next: "EMBER_STORAGE_SECRET_R0", remove: [] });
    expect(planRotation(["EMBER_STORAGE_SECRET"], "EMBER_STORAGE_SECRET")).toEqual({ next: "EMBER_STORAGE_SECRET_R1", remove: [] });
    expect(planRotation(["EMBER_STORAGE_SECRET", "EMBER_STORAGE_SECRET_R1"], "EMBER_STORAGE_SECRET")).toEqual({ next: "EMBER_STORAGE_SECRET_R2", remove: ["EMBER_STORAGE_SECRET"] });
    expect(planRotation(["EMBER_AUTH_SECRET", "EMBER_AUTH_SECRET_R1", "EMBER_AUTH_SECRET_R2"], "EMBER_AUTH_SECRET", true)).toEqual({ next: "EMBER_AUTH_SECRET_R3", remove: ["EMBER_AUTH_SECRET_R1"] });
    expect(generations(["EMBER_AUTH_SECRET_R10", "EMBER_AUTH_SECRET_R9", "EMBER_AUTH_SECRETX"], "EMBER_AUTH_SECRET").map((g) => g.gen)).toEqual([9, 10]);
  });

  it("rotates files + auth secret, then mints and publishes a JWT key", async () => {
    const calls: string[] = [];
    let names = ["EMBER_ADMIN_TOKEN", "EMBER_AUTH_SECRET", "EMBER_AUTH_JWKS", "EMBER_STORAGE_SECRET", "EMBER_STORAGE_SECRET_R1"];
    const client = {
      call: async (method: string, path: string, body?: any) => {
        calls.push(`${method} ${path}${body?.name ? ` ${body.name}` : ""}`);
        if (method === "GET") return names.map((name) => ({ name, type: "secret_text" }));
        if (method === "PUT") names = [...new Set([...names, body.name])];
        if (method === "DELETE") names = names.filter((n) => !path.endsWith(`/${n}`));
        return null;
      },
    } as any;
    const fetchImpl = (async (u: URL | string, init?: RequestInit) => {
      const p = new URL(String(u)).pathname;
      if (p === "/api/_ember/keys/rotate") return Response.json({ ok: true, kids: ["old", "new"] }, { status: init?.method === "POST" ? 200 : 405 });
      if (p === "/api/auth/jwks") return Response.json({ keys: [{ kid: "old" }, { kid: "new" }] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    await expect(rotateKeys({ client, worker: "w", url: "https://w.example", adminToken: "a", kinds: ["auth-secret"], fetch: fetchImpl, sleep: async () => {} })).rejects.toThrow(/--yes/);
    const r = await rotateKeys({ client, worker: "w", url: "https://w.example", adminToken: "a", kinds: ["files", "auth-secret"], yes: true, fetch: fetchImpl, log: () => {}, sleep: async () => {} });
    expect(r.files).toEqual({ added: "EMBER_STORAGE_SECRET_R2", removed: ["EMBER_STORAGE_SECRET"] });
    expect(r.authSecret).toEqual({ added: "EMBER_AUTH_SECRET_R1", removed: [] });
    expect(r.jwt).toEqual({ kids: ["old", "new"], jwksSecret: true });
    expect(calls).toContain("PUT /workers/scripts/w/secrets EMBER_AUTH_JWKS");
    expect(calls).toContain("DELETE /workers/scripts/w/secrets/EMBER_STORAGE_SECRET");
    expect(names.sort()).toEqual(["EMBER_ADMIN_TOKEN", "EMBER_AUTH_JWKS", "EMBER_AUTH_SECRET", "EMBER_AUTH_SECRET_R1", "EMBER_STORAGE_SECRET_R1", "EMBER_STORAGE_SECRET_R2"]);
  });

  it("a failing JWKS refresh reports the HTTP status, not an empty key set", async () => {
    const calls: string[] = [];
    const client = {
      call: async (method: string, path: string, body?: any) => {
        calls.push(`${method} ${path}${body?.name ? ` ${body.name}` : ""}`);
        return method === "GET" ? [{ name: "EMBER_AUTH_JWKS", type: "secret_text" }] : null;
      },
    } as any;
    const fetchImpl = (async (u: URL | string) => {
      const p = new URL(String(u)).pathname;
      if (p === "/api/_ember/keys/rotate") return Response.json({ ok: true, kids: ["old", "new"] });
      return Response.json({ ok: false, error: { code: "internal", message: "boom" } }, { status: 503 });
    }) as typeof fetch;
    await expect(rotateKeys({ client, worker: "w", url: "https://w.example", adminToken: "a", kinds: ["jwt"], fetch: fetchImpl, log: () => {}, sleep: async () => {} })).rejects.toThrow(/HTTP 503/);
    expect(calls).not.toContain("PUT /workers/scripts/w/secrets EMBER_AUTH_JWKS");
  });
});
