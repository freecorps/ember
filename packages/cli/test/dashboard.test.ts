import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prebuiltDashboard } from "../src/dashboard.ts";

describe("prebuiltDashboard", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = (files: string[]) => {
    const d = mkdtempSync(join(tmpdir(), "ember-dash-"));
    dirs.push(d);
    for (const f of files) writeFileSync(join(d, f), `/* ${f} */`);
    return d;
  };

  it("is null without a prebuilt copy", () => {
    expect(prebuiltDashboard(dir([]))).toBeNull();
  });

  it("reads a complete prebuilt copy", () => {
    const d = dir(["worker.js", "app.js", "app.css"]);
    expect(prebuiltDashboard(d)).toEqual({ js: "/* app.js */", css: "/* app.css */", worker: join(d, "worker.js") });
  });

  it("fails clearly on an incomplete copy", () => {
    expect(() => prebuiltDashboard(dir(["worker.js", "app.js"]))).toThrow(/incomplete \(missing app\.css\)/);
  });
});
