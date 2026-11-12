// Application errors (docs/design/dx.md §3.2): defineErrors, the builders' `errors:` and `ctx.fail`, the wire form,
// and `ctx.auth.require()`.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AppError,
  defineErrors,
  EmberError,
  errorFromWire,
  errorInfo,
  isAppError,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  v,
  type ErrorSpecsOf,
  type MutationCtx,
} from "../src/index.ts";
import { fresh } from "./fixtures.ts";

const errors = defineErrors({
  TooLong: { data: v.object({ max: v.number() }), message: (d: { max: number }) => `at most ${d.max}` },
  Closed: { message: "The channel is closed" },
  Big: { data: v.object({ n: v.int64() }) },
});

describe("defineErrors", () => {
  it("builds typed AppErrors with validated data and messages", () => {
    const e = errors.TooLong({ max: 3 });
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(EmberError);
    expect(e).toMatchObject({ kind: "app", code: "TooLong", data: { max: 3 }, message: "at most 3" });
    expectTypeOf(e.data).toEqualTypeOf<{ max: number }>();
    expectTypeOf(e.code).toEqualTypeOf<"TooLong">();
    expect(errors.Closed().message).toBe("The channel is closed");
    expect(errors.Closed(undefined, { message: "custom" }).message).toBe("custom");
    expect(errors.TooLong.is(e)).toBe(true);
    expect(errors.Closed.is(e)).toBe(false);
    expect(errors.TooLong.code).toBe("TooLong");
    expect(errors.TooLong.shape).toEqual({ kind: "object", fields: { max: { shape: { kind: "number" }, optional: false } } });
  });

  it("refuses bad data, bad codes and conflicting definitions", () => {
    expect(() => errors.TooLong({ max: "x" } as never)).toThrow(/errors.TooLong: invalid data at max/);
    expect(() => (errors.Closed as (d: unknown) => unknown)({ x: 1 })).toThrow(/takes no data/);
    expect(() => defineErrors({ notPascal: {} })).toThrow(/PascalCase/);
    expect(() => defineErrors({ TooLong: { data: v.object({ max: v.string() }) } })).toThrow(/defined twice with different data/);
    expect(() => defineErrors({ TooLong: { data: v.object({ max: v.number() }) } })).not.toThrow(); // same shape: fine
  });

  it("wire form: kind and data for app errors; codes for the rest", () => {
    expect(errorInfo(errors.Big({ n: 5n }))).toEqual({ code: "Big", message: "Big", data: { n: 5n }, kind: "app" });
    expect(errorInfo(new EmberError("NotFound", "x"))).toEqual({ code: "NotFound", message: "x" });
    expect(errorInfo(new Error("plain"))).toEqual({ code: "Error", message: "plain" });
    const back = errorFromWire({ code: "Big", message: "m", data: { n: 1n }, kind: "app" });
    expect(isAppError(back) && back.code).toBe("Big");
    expect(isAppError(errorFromWire({ code: "NotFound", message: "m" }))).toBe(false);
  });
});

describe("functions with errors", () => {
  it("`errors:` is kept on the function, typed, and `ctx.fail` throws them (rolling back)", () => {
    const send = mutationGeneric({
      args: { channel: v.string() },
      errors: [errors.TooLong, errors.Closed],
      handler: (ctx, { channel }) => {
        ctx.db.insert("users", { name: channel, email: `${channel}@x`, admin: false });
        if (channel === "closed") ctx.fail.Closed();
        if (channel.length > 3) return ctx.fail.TooLong({ max: 3 });
        // @ts-expect-error not declared
        void ctx.fail.Big;
        return channel;
      },
    });
    expect(send.errors?.map((e) => e.code)).toEqual(["TooLong", "Closed"]);
    expectTypeOf<NonNullable<typeof send.__errors>>().toEqualTypeOf<ErrorSpecsOf<[typeof errors.TooLong, typeof errors.Closed]>>();
    const s = fresh();
    expect(s.engine.runMutation(send as never, { channel: "ok" }).value).toBe("ok");
    expect(() => s.engine.runMutation(send as never, { channel: "toolong" })).toThrow(expect.objectContaining({ code: "TooLong", kind: "app", data: { max: 3 } }));
    expect(() => s.engine.runMutation(send as never, { channel: "closed" })).toThrow(expect.objectContaining({ code: "Closed" }));
    expect(s.sql("SELECT count(*) AS n FROM users")[0]!.n).toBe(1);
  });

  it("refuses an `errors` list that is not defineErrors entries", () => {
    expect(() => mutationGeneric({ errors: [() => new Error("x")] as never, handler: () => null })).toThrow(/defineErrors/);
  });

  it("ctx.auth.require(): the identity, or Unauthenticated", () => {
    const me = queryGeneric({ handler: (ctx) => ctx.auth.require().subject });
    const s = fresh();
    expect(s.engine.runQuery(me as never, {}, { identity: { subject: "u1" } }).value).toBe("u1");
    expect(() => s.engine.runQuery(me as never, {})).toThrow(expect.objectContaining({ code: "Unauthenticated", kind: "system" }));
  });

  it("a nested mutation's error reaches the caller, which may catch it", () => {
    const inner = mutationGeneric({ errors: [errors.Closed], handler: (ctx: MutationCtx & { fail: { Closed(): never } }) => ctx.fail.Closed() });
    const outer = mutationGeneric({
      handler: (ctx) => {
        try {
          ctx.runMutation(makeFunctionReference<"mutation", {}>("m:inner"));
          return "no";
        } catch (e) {
          return errors.Closed.is(e) ? "caught" : "other";
        }
      },
    });
    const s = fresh({ functions: { m: { inner, outer } } as never });
    expect(s.engine.runMutation("m:outer", {}).value).toBe("caught");
  });
});
