// The committed inline script is the current build of sdk.ts, and it runs on its own: it defines
// window.EmberDashboard with a working connect() (the same handshake as the module's).
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { buildSdkScript, scriptModule } from "../scripts/sdk-script.ts";
import { EMBED_SDK_SCRIPT, EMBED_PROTOCOL } from "../src/index.ts";

describe("EMBED_SDK_SCRIPT", () => {
  test("is up to date with sdk.ts (bun scripts/sdk-script.ts)", async () => {
    const built = await buildSdkScript();
    expect(readFileSync(new URL("../src/script.ts", import.meta.url), "utf8")).toBe(scriptModule(built));
    expect(EMBED_SDK_SCRIPT).toBe(built);
  });

  test("is self-contained, ASCII, and safe inside a <script> element", () => {
    expect(EMBED_SDK_SCRIPT).not.toMatch(/<\/script|<!--/i);
    expect(/^[\x20-\x7e\n]*$/.test(EMBED_SDK_SCRIPT)).toBe(true);
    const sent: Array<{ msg: unknown; target: string }> = [];
    const parent = { postMessage: (msg: unknown, target: string) => void sent.push({ msg, target }) };
    const fakeWindow: Record<string, unknown> = { parent, addEventListener() {}, removeEventListener() {}, setTimeout: () => 0, clearTimeout() {} };
    fakeWindow.window = fakeWindow;
    // Runs with nothing but `window` in scope (no module helpers, no `__name`).
    new Function("window", EMBED_SDK_SCRIPT)(fakeWindow);
    const sdk = fakeWindow.EmberDashboard as { connect(): { close(): void }; DashboardError: unknown };
    expect(typeof sdk.DashboardError).toBe("function");
    sdk.connect().close();
    expect(sent).toEqual([{ msg: { ember: EMBED_PROTOCOL, v: 1, type: "hello" }, target: "*" }]);
  });
});
