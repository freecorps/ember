// Lazy actions (`lazyActions`, the stand-ins of a module of actions only that the CLI's Worker entry imports on first
// use) through the real `ActionRunner`: the same gates as a static action, a failed import is an error outcome and is
// retried, and a loaded definition that differs from the build's metadata never runs.
import { env } from "cloudflare:test";
import { actionGeneric, internalActionGeneric, lazyActions, type LazyActionMeta } from "@freecorps/ember-server";
import { v } from "@freecorps/ember-values";
import { describe, expect, it } from "vitest";
import { ActionRunner, type EmberConfig, type ShardApi } from "../src/index.ts";
import { config } from "./worker.ts";
import { shardStub } from "./helpers.ts";

const echo = actionGeneric({ args: { n: v.number() }, handler: async (_ctx: unknown, { n }: { n: number }) => n * 2 });
const hidden = internalActionGeneric({ args: {}, handler: async () => "hidden" });
const metaOf = (f: { visibility: string; args: unknown }): LazyActionMeta => ({ type: "action", visibility: f.visibility, args: f.args } as LazyActionMeta);

function runner(load: () => Promise<Record<string, unknown>>, meta: Record<string, LazyActionMeta>) {
  const cfg: EmberConfig = { ...config, functions: { ...(config.functions as Record<string, unknown>), lz: lazyActions(load, meta) } } as EmberConfig;
  return new ActionRunner(cfg, env as never, (s) => shardStub(s) as unknown as ShardApi);
}

describe("lazy actions in the ActionRunner", () => {
  it("a failed import is an error outcome, and the next call imports again", async () => {
    let attempts = 0;
    const r = runner(async () => {
      if (attempts++ === 0) throw new Error("chunk fetch failed");
      return { echo };
    }, { echo: metaOf(echo) });
    const first = await r.run("lz:echo", { n: 2 }, "global:main", null);
    expect(first).toMatchObject({ ok: false, error: { message: expect.stringContaining("chunk fetch failed") } });
    expect(await r.run("lz:echo", { n: 2 }, "global:main", null)).toMatchObject({ ok: true, value: 4 });
    expect(attempts).toBe(2);
  });

  it("internal: not callable by a client, callable internally", async () => {
    const r = runner(async () => ({ hidden }), { hidden: metaOf(hidden) });
    expect(await r.run("lz:hidden", {}, "global:main", null)).toMatchObject({ ok: false, error: { code: "FunctionNotFound" } });
    expect(await r.run("lz:hidden", {}, "global:main", null, { internal: true })).toMatchObject({ ok: true, value: "hidden" });
  });

  it("a definition that is internal once loaded does not run for a client, though the build recorded it public", async () => {
    let ran = 0;
    const real = internalActionGeneric({ args: {}, handler: async () => (ran++, "ran") });
    const r = runner(async () => ({ flip: real }), { flip: { type: "action", visibility: "public", args: real.args } as LazyActionMeta });
    const out = await r.run("lz:flip", {}, "global:main", null);
    expect(out.ok).toBe(false);
    expect(ran).toBe(0);
  });
});
