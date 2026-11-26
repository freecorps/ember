// `lazyActions`: stand-ins for a module of actions imported on first use (the Worker entry `ember` generates).
import { describe, expect, it } from "vitest";
import { actionGeneric, defineErrors, errorCodesOf, flattenFunctions, isLazyFunction, lazyActions, loadFunction, v, type LazyActionMeta } from "../src/index.ts";

const errors = defineErrors({ TooBig: { data: v.object({ max: v.number() }) } });
const send = actionGeneric({ args: { to: v.string() }, returns: v.number(), errors: [errors.TooBig], dispatch: "shard", handler: async (_ctx: unknown, { to }: { to: string }) => to.length });
const meta: LazyActionMeta = { type: "action", visibility: "public", args: send.args, returns: send.returns!, dispatch: "shard", declaresErrors: true, errorCodes: ["TooBig"] };

describe("lazyActions", () => {
  it("registers stand-ins with the build's metadata; the module loads once, on first use", async () => {
    let loads = 0;
    const mod = lazyActions(async () => (loads++, { send }), { send: meta });
    const fns = flattenFunctions({ mailer: mod });
    const stub = fns.get("mailer:send") as typeof send;
    expect(stub).toMatchObject({ type: "action", visibility: "public", dispatch: "shard", args: send.args });
    expect(isLazyFunction(stub)).toBe(true);
    expect(isLazyFunction(send)).toBe(false);
    expect(errorCodesOf(stub)).toEqual(["TooBig"]);
    expect(errorCodesOf(send)).toEqual(["TooBig"]);
    expect(loads).toBe(0);
    expect(await loadFunction(stub)).toBe(send);
    expect(await stub.handler({}, { to: "abc" })).toBe(3);
    expect(loads).toBe(1);
    expect(await loadFunction(send)).toBe(send);
  });

  it("a failed import is retried by the next call; an export that is no longer an action fails clearly", async () => {
    let attempt = 0;
    const mod = lazyActions(async () => {
      if (attempt++ === 0) throw new Error("network");
      return { send };
    }, { send: meta, gone: meta });
    await expect(loadFunction(mod.send)).rejects.toThrow("network");
    expect(await loadFunction(mod.send)).toBe(send);
    await expect(loadFunction(mod.gone)).rejects.toThrow(/no longer exports it as an action/);
  });
});
