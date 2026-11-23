/**
 * `@freecorps/ember-auth/remote` (what the generated SSO Worker imports) bundles `remoteAuth` with `jose` and the
 * session lookup only: no Better Auth anywhere in its import graph. `/worker` (the full entry) is the contrast.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (f: string) => join(pkgDir, "src", f);

/** As the CLI bundles a Worker (packages/cli/src/worker-bundle.ts): browser platform, workerd conditions. */
async function bundle(entry: string) {
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    target: "es2023",
    conditions: ["@freecorps/ember-source", "workerd", "worker", "browser", "import", "module"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  const inputs = Object.keys(r.metafile.inputs);
  const bytes = r.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
  return { inputs, bytes };
}

const isBetterAuth = (p: string) => /(^|\/)node_modules\/(better-auth|@better-auth)\//.test(p);

describe("@freecorps/ember-auth/remote", () => {
  it("is in package.json exports (dist + the source condition)", () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports: Record<string, Record<string, string>> };
    expect(pkg.exports["./remote"]).toEqual({ "@freecorps/ember-source": "./src/remote.ts", types: "./dist/remote.d.ts", default: "./dist/remote.js" });
  });

  it("has no Better Auth in its import graph; the full /worker entry does", async () => {
    const remote = await bundle(src("remote.ts"));
    expect(remote.inputs.filter(isBetterAuth)).toEqual([]);
    expect(remote.inputs.some((p) => p.includes("node_modules/jose/"))).toBe(true);
    expect(remote.inputs.some((p) => p.endsWith("src/remote-session.ts"))).toBe(true);
    expect(remote.inputs.some((p) => p.endsWith("src/verify.ts") || p.endsWith("src/worker.ts") || p.endsWith("src/settings.ts"))).toBe(false);

    const worker = await bundle(src("worker.ts"));
    expect(worker.inputs.some(isBetterAuth)).toBe(true);
    // Hundreds of KiB less to upload and evaluate at cold start (~750 KiB when this was written).
    expect(worker.bytes - remote.bytes).toBeGreaterThan(400 * 1024);
  }, 60_000);
});
