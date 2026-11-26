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
    // Timers the test runs by hand: the hello repeats on each, and close() clears the one pending.
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextTimer = 0;
    const fire = () => {
      const [h, t] = [...timers][0] ?? [];
      if (h === undefined || !t) return false;
      timers.delete(h);
      t.fn();
      return true;
    };
    const fakeWindow: Record<string, unknown> = {
      structuredClone, // a page's globalThis has it (connect() needs it)
      parent,
      addEventListener() {},
      removeEventListener() {},
      setTimeout: (fn: () => void, ms: number) => (timers.set(++nextTimer, { fn, ms }), nextTimer),
      clearTimeout: (h: number) => void timers.delete(h),
    };
    fakeWindow.window = fakeWindow;
    // Runs with nothing but `window` (and `globalThis`, which is it in a page) in scope (no module helpers, no `__name`).
    new Function("window", "globalThis", EMBED_SDK_SCRIPT)(fakeWindow, fakeWindow);
    const sdk = fakeWindow.EmberDashboard as { connect(): { close(): void }; DashboardError: unknown };
    expect(typeof sdk.DashboardError).toBe("function");
    const hello = { msg: { ember: EMBED_PROTOCOL, v: 1, type: "hello" }, target: "*" };
    const dash = sdk.connect();
    expect(sent).toEqual([hello]);
    expect([...timers.values()].map((t) => t.ms)).toEqual([200]);
    // Each timer sends the hello again and arms the next one.
    expect(fire()).toBe(true);
    expect(fire()).toBe(true);
    expect(sent).toEqual([hello, hello, hello]);
    expect(timers.size).toBe(1);
    // close() clears the pending timer: no more hellos.
    dash.close();
    expect(timers.size).toBe(0);
    expect(fire()).toBe(false);
    expect(sent).toHaveLength(3);
  });
});
