/**
 * `ember.passwordRules` and `ember.hiddenUserFields` of ember/auth.config.ts: the build carries the rules into the
 * generated entry's static settings (so `emberAuthLazy` routes them without Better Auth), and codegen hides the
 * fields from `auth:user` (and fails on a name that is not a user field). No Miniflare: codegen and the build only.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, type Project } from "../src/config.ts";
import { init } from "../src/init.ts";
import { cleanup, TMP } from "./helpers.ts";

const CONFIG = `import { defineAuth } from "@freecorps/ember-auth";
import { organization } from "@freecorps/ember-auth/plugins";

/** A third-party plugin: a secret on the user row and its own password endpoint. */
const vault = () => ({ id: "vault", schema: { user: { fields: { vaultSecret: { type: "string", required: false } } } } }) as never;

export default defineAuth({
  emailAndPassword: { enabled: true },
  plugins: [organization(), vault()],
  ember: {
    replicate: { organization: true },
    passwordRules: { "/vault/unlock": { verify: { field: "secret", by: "email" } } },
    hiddenUserFields: ["vaultSecret"],
  },
});
`;

let project: Project;
let configFile: string;

beforeAll(() => {
  const dir = join(TMP, `auth-rules-${process.pid}`);
  // A clean directory (as `sampleProject` makes): nothing left by an earlier run with the same pid.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  init({ dir, project: "chat", auth: true, force: true });
  project = loadProject(dir);
  configFile = join(project.dir, "auth.config.ts");
  writeFileSync(configFile, CONFIG);
});
afterAll(() => {
  if (project) cleanup(project);
});

describe("ember.passwordRules / ember.hiddenUserFields in auth.config.ts", () => {
  it("codegen hides the field from auth:user (descriptor, replica table, types)", async () => {
    await codegen(project);
    const manifest = JSON.parse(readFileSync(join(project.generatedDir, "manifest.json"), "utf8"));
    type Field = { name: string; hidden: boolean };
    const user = (manifest.auth.tables as { name: string; fields: Field[] }[]).find((t) => t.name === "auth:user")!;
    expect(user.fields.find((f) => f.name === "vaultSecret")).toMatchObject({ hidden: true });
    expect(user.fields.find((f) => f.name === "email")).toMatchObject({ hidden: false });
    const replica = (manifest.auth.replicas as { name: string; fields: Field[] }[]).find((t) => t.name === "auth:user")!;
    expect(replica.fields.map((f) => f.name)).toContain("email");
    expect(replica.fields.map((f) => f.name)).not.toContain("vaultSecret");
    expect(readFileSync(join(project.generatedDir, "dataModel.d.ts"), "utf8")).not.toContain("vaultSecret");
  });

  it("the generated entry carries the rules in the static settings", async () => {
    const b = await buildWorker(project, { outDir: join(project.stateDir, "build", "worker-rules") });
    expect(b.auth?.kind).toBe("local");
    const src = readFileSync(join(project.stateDir, "build", "worker-rules", "entry.mjs"), "utf8");
    expect(src).toContain(`"worker":{"hasher":"default","passwordRules":{"/vault/unlock":{"verify":{"field":"secret","by":"email"}}}}`);
    // The replica spec embedded for the org shards has no hidden field either.
    expect(src).not.toContain("vaultSecret");
  });

  it("codegen refuses a hidden name that is not a user field", async () => {
    writeFileSync(configFile, CONFIG.replace(`hiddenUserFields: ["vaultSecret"]`, `hiddenUserFields: ["vault_secret"]`));
    try {
      await expect(codegen(project)).rejects.toThrow(/hiddenUserFields names "vault_secret", which is not a field of the user model/);
    } finally {
      writeFileSync(configFile, CONFIG);
    }
  });

  it("defineAuth refuses a malformed rule when the config is evaluated", async () => {
    writeFileSync(configFile, CONFIG.replace(`by: "email"`, `by: "nickname"`));
    try {
      await expect(codegen(project)).rejects.toThrow(/ember\.passwordRules: rule "\/vault\/unlock": verify\.by must be one of/);
    } finally {
      writeFileSync(configFile, CONFIG);
    }
  });
});
