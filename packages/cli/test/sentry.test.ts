// `ember sentry sourcemaps upload` against a fake runtime that speaks the sentry component's upload routes
// (POST <prefix>/admin/sourcemaps → missing, PUT <prefix>/admin/sourcemaps/blobs/<sha256>, POST again).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { artifactNameFor, collectSourceMaps, scriptComments, sentryPrefix, uploadSourceMaps } from "../src/sentry.ts";

const TOKEN = "upload-token";

/** The component's upload protocol, in memory: blobs by sha256, rows by (project, release, dist, name). */
function fakeRuntime(prefix = "/sentry") {
  const blobs = new Map<string, Buffer>();
  const rows = new Map<string, { sha256: string; debugId?: string }>();
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 });
    if (init?.method === "PUT" && url.pathname.startsWith(`${prefix}/admin/sourcemaps/blobs/`)) {
      const sha = url.pathname.split("/").pop()!;
      const raw = Buffer.from(init.body as Uint8Array);
      const body = new Headers(init.headers).get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
      if (createHash("sha256").update(body).digest("hex") !== sha) return Response.json({ ok: false, error: { code: "hash_mismatch", message: "x" } }, { status: 400 });
      blobs.set(sha, body);
      return Response.json({ ok: true, sha256: sha, stored: true });
    }
    if (init?.method === "POST" && url.pathname === `${prefix}/admin/sourcemaps`) {
      const m = JSON.parse(String(init.body)) as { project: string; release: string; dist?: string; files: Array<{ name: string; sha256: string; debugId?: string }> };
      const missing = [...new Set(m.files.map((f) => f.sha256))].filter((s) => !blobs.has(s));
      if (missing.length) return Response.json({ ok: false, missing });
      let added = 0;
      for (const f of m.files) {
        const k = `${m.project}\n${m.release}\n${m.dist ?? ""}\n${f.name}`;
        if (!rows.has(k)) added++;
        rows.set(k, { sha256: f.sha256, ...(f.debugId ? { debugId: f.debugId } : {}) });
      }
      return Response.json({ ok: true, added, files: m.files.length });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch, blobs, rows, calls };
}

const map = (file: string, extra: object = {}) => JSON.stringify({ version: 3, file, sources: ["src/app.ts"], names: [], mappings: "AAAA", ...extra });

/** A Vite-like build: assets/app-abc.js (+ map, debug id in the script), assets/vendor.js.map (debug id in the map), a stray .map. */
function build() {
  const dir = mkdtempSync(join(tmpdir(), "ember-sentry-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app-abc.js"), 'console.log(1);\n//# debugId=0123456789ABCDEF0123456789ABCDEF\n//# sourceMappingURL=maps/app.js.map\n');
  mkdirSync(join(dir, "assets", "maps"));
  writeFileSync(join(dir, "assets", "maps", "app.js.map"), map("app-abc.js"));
  writeFileSync(join(dir, "assets", "vendor.js"), "x();\n//# sourceMappingURL=vendor.js.map\n");
  writeFileSync(join(dir, "assets", "vendor.js.map"), map("vendor.js", { debugId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" }));
  writeFileSync(join(dir, "notes.map"), "not json");
  return dir;
}

describe("ember sentry sourcemaps upload", () => {
  test("collects the maps named after the scripts that reference them, with their debug ids", () => {
    const files = collectSourceMaps(build());
    expect(files.map(({ path: _p, sha256: _s, ...f }) => f)).toEqual([
      { name: "~/assets/app-abc.js", size: map("app-abc.js").length, debugId: "01234567-89ab-cdef-0123-456789abcdef" },
      { name: "~/assets/vendor.js", size: map("vendor.js", { debugId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" }).length, debugId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    ]);
    expect(files[0]!.sha256).toBe(createHash("sha256").update(map("app-abc.js")).digest("hex"));
    expect(artifactNameFor("assets/app.js", "https://cdn.test/static")).toBe("~/static/assets/app.js");
    expect(artifactNameFor("app.js", "~/js/")).toBe("~/js/app.js");
    expect(scriptComments("a\n//# sourceMappingURL=a.map\n//@ sourceMappingURL=b.map")).toEqual({ sourceMappingURL: "b.map", debugId: null });
  });

  test("sends the manifest, then only the maps the runtime lacks (gzipped), then registers them; a second upload sends no map", async () => {
    const rt = fakeRuntime();
    const dir = build();
    const lines: string[] = [];
    const o = { url: "https://app.test", token: TOKEN, project: "web", release: "1.2.3", fetch: rt.fetch, log: (l: string) => lines.push(l) };
    const r = await uploadSourceMaps(dir, o);
    expect(r).toMatchObject({ uploaded: 2, added: 2 });
    expect(rt.calls).toEqual(["POST /sentry/admin/sourcemaps", expect.stringMatching(/^PUT \/sentry\/admin\/sourcemaps\/blobs\/[0-9a-f]{64}$/), expect.stringMatching(/^PUT /), "POST /sentry/admin/sourcemaps"]);
    expect([...rt.rows.keys()]).toEqual(["web\n1.2.3\n\n~/assets/app-abc.js", "web\n1.2.3\n\n~/assets/vendor.js"]);
    expect(rt.rows.get("web\n1.2.3\n\n~/assets/app-abc.js")!.debugId).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(lines.at(-1)).toContain("Uploaded 2 new map(s) of 2");
    // Same build, next release (dist too): the blobs are known (dedup by sha256), one call registers it.
    rt.calls.length = 0;
    const again = await uploadSourceMaps(dir, { ...o, release: "1.2.4", dist: "ios" });
    expect(again).toMatchObject({ uploaded: 0, added: 2 });
    expect(rt.calls).toEqual(["POST /sentry/admin/sourcemaps"]);
    expect(rt.blobs.size).toBe(2);
  });

  test("another prefix, dry run, and the refusals: bad token, no maps, http:// to a non-local host", async () => {
    const rt = fakeRuntime("/errors");
    const dir = build();
    const log = () => {};
    await expect(uploadSourceMaps(dir, { url: "https://app.test", token: TOKEN, project: "web", release: "1", httpPrefix: "/errors", fetch: rt.fetch, log })).resolves.toMatchObject({ added: 2 });
    rt.calls.length = 0;
    await expect(uploadSourceMaps(dir, { url: "https://app.test", token: TOKEN, project: "web", release: "1", dryRun: true, fetch: rt.fetch, log })).resolves.toMatchObject({ uploaded: 0 });
    expect(rt.calls).toEqual([]);
    await expect(uploadSourceMaps(dir, { url: "https://app.test", token: "wrong", project: "web", release: "1", httpPrefix: "/errors", fetch: rt.fetch, log })).rejects.toThrow(/token was refused/);
    await expect(uploadSourceMaps(mkdtempSync(join(tmpdir(), "ember-empty-")), { url: "https://app.test", token: TOKEN, project: "web", release: "1", fetch: rt.fetch, log })).rejects.toThrow(/No source maps/);
    await expect(uploadSourceMaps(dir, { url: "http://example.com", token: TOKEN, project: "web", release: "1", fetch: rt.fetch, log })).rejects.toThrow(/Refusing to send/);
    await expect(uploadSourceMaps(dir, { url: "https://app.test", token: TOKEN, project: "web", release: "1", fetch: rt.fetch, log })).rejects.toThrow(/No sentry component/);
  });

  test("the install's prefix from the manifest", () => {
    const comps = { sentry: { component: "sentry", httpPrefix: "/sentry" }, mail: { component: "email", httpPrefix: "/email" } };
    expect(sentryPrefix(comps)).toBe("/sentry");
    expect(sentryPrefix({ ...comps, other: { component: "sentry", httpPrefix: "/errors" } }, "other")).toBe("/errors");
    expect(() => sentryPrefix({ ...comps, other: { component: "sentry", httpPrefix: "/errors" } })).toThrow(/more than once/);
    expect(() => sentryPrefix({ mail: comps.mail })).toThrow(/not installed/);
  });
});
