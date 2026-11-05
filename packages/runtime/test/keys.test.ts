// Secret rotation by generation (`ember keys rotate --files`): the newest generation signs, every bound one verifies.
import { env } from "cloudflare:test";
import { proxyGetSignature } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { fileSignerFromEnv, handleStorageRequest, rotatedSecrets } from "../src/files.ts";

describe("rotated storage secrets", () => {
  it("orders generations newest first", () => {
    expect(rotatedSecrets({ EMBER_STORAGE_SECRET: "g0", EMBER_STORAGE_SECRET_R2: "g2", EMBER_STORAGE_SECRET_R10: "g10", OTHER: "x" }, "EMBER_STORAGE_SECRET")).toEqual(["g10", "g2", "g0"]);
    expect(rotatedSecrets({}, "EMBER_STORAGE_SECRET")).toEqual([]);
  });

  it("signs with the newest generation and accepts URLs signed with the previous one", async () => {
    const e = { ...env, EMBER_STORAGE_SECRET: "old-secret", EMBER_STORAGE_SECRET_R1: "new-secret", EMBER_PUBLIC_URL: "http://ember" } as any;
    const signer = fileSignerFromEnv(e)!;
    expect(signer.mode).toBe("proxy");
    const exp = Math.floor(Date.now() / 1000) + 600;
    const get = async (secret: string) => {
      const url = new URL(`http://ember/api/storage/get?k=f/x/missing&exp=${exp}&sig=${proxyGetSignature(secret, "f/x/missing", exp, "", "")}`);
      const res = await handleStorageRequest(new Request(url), url, { env: e, checkShard: (s) => (typeof s === "string" ? s : null), rpc: () => ({}) as any });
      return res!.status;
    };
    // Signature accepted → the (missing) object is looked up: 404. Refused → 403.
    expect(await get("new-secret")).toBe(404);
    expect(await get("old-secret")).toBe(404);
    expect(await get("never-bound")).toBe(403);
    const signed = new URL(signer.getUrl("f/x/missing", { now: Date.now(), expiresIn: 600 } as any));
    expect(signed.searchParams.get("sig")).toBe(proxyGetSignature("new-secret", "f/x/missing", Number(signed.searchParams.get("exp")), signed.searchParams.get("ct") ?? "", signed.searchParams.get("dl") ?? ""));
  });
});
