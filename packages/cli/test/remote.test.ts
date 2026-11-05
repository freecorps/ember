// `ember dev --remote`: which bindings go remote, which env they belong to, and how they reach Miniflare. The real
// session (wrangler's remote proxy against Cloudflare) is exercised by docs/spikes/remote/integrations-e2e.md.
import { describe, expect, it } from "vitest";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";
import { projectFrom, type EmberConfigFile } from "../src/config.ts";
import { planAiResources } from "../src/deploy/ai.ts";
import { miniflareOptions, remoteBindingOptions } from "../src/local.ts";
import { planRemote, remoteEnv } from "../src/remote.ts";

const config: EmberConfigFile = { project: "kb", compatibilityDate: "2026-10-01", environments: { prod: {}, dev: {} }, resources: { browser: true } };
const project = projectFrom("/tmp/ember-remote-test", config);
const schema = defineSchema({
  tables: {
    notes: defineTable({ body: v.string(), lang: v.string() })
      .vectorIndex("semantic", { embed: "body", filterFields: ["lang"] })
      .aiSearchIndex("hybrid", { fields: ["body"] }),
  },
}).manifest;

describe("ember dev --remote", () => {
  it("binds the env's own Vectorize indexes (same names as ember deploy), Workers AI and Browser; AI Search stays local; no queue", () => {
    const p = planRemote(project, "dev", schema);
    const vec = planAiResources(schema, "kb", "dev").vectorize[0]!.name;
    expect(p.bindings).toEqual({
      EMBER_AI: { type: "ai" },
      EMBER_VEC__notes__semantic: { type: "vectorize", index_name: vec },
      EMBER_BROWSER: { type: "browser" },
    });
    expect(p.ai.queue).toBeNull();
    expect(p.ai.aiSearch).toEqual([]);
    expect(p.localAiSearch).toEqual(["notes.hybrid"]);
    expect(p.names).toEqual({ ai: true, vectorize: { EMBER_VEC__notes__semantic: vec }, aiSearch: {}, browser: true, images: false });
  });

  it("defaults to the dev environment and never to prod implicitly", () => {
    expect(remoteEnv(project, undefined)).toBe("dev");
    expect(remoteEnv(project, "prod")).toBe("prod");
    expect(() => remoteEnv(project, "staging")).toThrow(/Unknown environment/);
    expect(() => remoteEnv(projectFrom("/tmp/x", { ...config, environments: { prod: {} } }), undefined)).toThrow(/pass --env/);
  });

  it("Miniflare gets each remote binding with the proxy connection string; the local fallback flag stays for unbound indexes", () => {
    const connection = new URL("http://127.0.0.1:61234/");
    const names = planRemote(project, "dev", schema).names;
    const o = remoteBindingOptions({ connection, ...names }) as any;
    expect(o.ai).toEqual({ binding: "EMBER_AI", remoteProxyConnectionString: connection });
    expect(o.vectorize.EMBER_VEC__notes__semantic).toEqual({ index_name: names.vectorize.EMBER_VEC__notes__semantic, remoteProxyConnectionString: connection });
    expect(o.aiSearchInstances).toBeUndefined();
    expect(remoteBindingOptions({ connection, ...names, aiSearch: { EMBER_AIS__x__y: "inst" } }).aiSearchInstances).toEqual({ EMBER_AIS__x__y: { instance_name: "inst", remoteProxyConnectionString: connection } });
    expect(o.browserRendering).toEqual({ binding: "EMBER_BROWSER", remoteProxyConnectionString: connection });
    const build = { code: "export default {}", entry: "", outFile: "/tmp/index.js", bytes: 1, sha256: "x", auth: null };
    const mf = miniflareOptions(project, build, { persist: false, remote: { connection, ...names } }) as any;
    const env = mf.workers[0].config.env;
    expect(env.EMBER_AI_INDEXES).toEqual({ type: "text", value: "local" });
    for (const b of ["EMBER_AI", "EMBER_VEC__notes__semantic", "EMBER_BROWSER"]) expect(env[b]).toBeDefined();
    expect(env.EMBER_AIS__notes__hybrid).toBeUndefined(); // → local BM25 fallback (EMBER_AI_INDEXES=local)
    expect(miniflareOptions(project, build, { persist: false }).workers[0]!.config.env).not.toHaveProperty("EMBER_BROWSER");
  });
});
