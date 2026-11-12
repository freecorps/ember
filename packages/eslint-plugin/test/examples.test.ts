// The recommended rules over the repo's example apps: real code, no false positives.
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("recommended rules on examples/", () => {
  it("report nothing", async () => {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [{ files: ["**/*.ts", "**/*.tsx"], languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } } }, plugin.configs.recommended as never],
    });
    const results = await eslint.lintFiles(["examples/*/ember/*.ts", "examples/*/web/src/**/*.{ts,tsx}"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${r.filePath.slice(root.length)}:${m.line} ${m.ruleId}: ${m.message}`));
    expect(results.length).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  }, 60_000);
});
