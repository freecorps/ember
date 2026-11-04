import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codegen } from "../cli/codegen";

const ROOT = join(import.meta.dir, "..");
const tsc = (project: string) => {
  const r = Bun.spawnSync(["node_modules/.bin/tsc", "--noEmit", "-p", project], { cwd: ROOT });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

describe("codegen + tsc", () => {
  test("codegen emits api / dataModel / server / modules + manifests", async () => {
    const { modules, functions } = await codegen(join(ROOT, "sample"));
    expect(modules).toEqual(["messages", "nested/admin", "users"]);
    expect((functions as any[]).map((f) => `${f.name}:${f.type}:${f.visibility}`)).toEqual([
      "messages:like:mutation:public", "messages:list:query:public", "messages:popular:query:public",
      "messages:purgeChannel:mutation:internal", "messages:search:query:public", "messages:send:mutation:public",
      "messages:similar:query:public", "nested/admin:health:httpAction:public", "nested/admin:stats:query:internal",
      "users:byEmail:query:public", "users:count:query:public", "users:create:mutation:public",
    ]);
    const api = readFileSync(join(ROOT, "sample/_generated/api.d.ts"), "utf8");
    expect(api).toContain(`import type * as mod_nested_admin from "../functions/nested/admin";`);
    expect(api).toContain(`export declare const api: FilterApi<typeof fullApi, "public">;`);
  });

  test("sample/client.ts (precise type assertions) type-checks", () => {
    const r = tsc(".");
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  }, 60_000);

  test("every `// ERR` line in client_error.ts / server_error.ts fails, and nothing else does", () => {
    const r = tsc("tsconfig.error.json");
    expect(r.code).not.toBe(0);
    const got = new Set([...r.out.matchAll(/^(sample\/\w+\.ts)\((\d+),\d+\): error/gm)].map((m) => `${m[1]}:${m[2]}`));
    const want = new Set<string>();
    for (const f of ["sample/client_error.ts", "sample/server_error.ts"]) {
      readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
        if (!line.trim().startsWith("//") && line.includes("// ERR")) want.add(`${f}:${i + 1}`);
      });
    }
    expect(want.size).toBe(21);
    expect([...got].sort()).toEqual([...want].sort());
  }, 60_000);
});
