import { describe, expect, it } from "vitest";
import { authorizeChannel, checkChannelValue, defineApp, defineChannel, matchChannel, v } from "../src/index.ts";

describe("channels (defineApp({ channels }))", () => {
  const app = defineApp({
    channels: {
      "room:*": { authorize: (identity) => identity !== null },
      "room:vip:*": { authorize: (identity) => identity?.subject === "ana" },
      "room:lobby": { authorize: () => true },
      typed: defineChannel({ authorize: () => true, payload: v.object({ x: v.number() }), state: v.optional(v.object({ name: v.string() })) }),
    },
  });

  it("matches the exact name first, then the longest prefix", () => {
    expect(matchChannel(app.channels, "room:lobby")?.param).toBe("");
    expect(matchChannel(app.channels, "room:vip:1")).toMatchObject({ param: "1", def: app.channels["room:vip:*"] });
    expect(matchChannel(app.channels, "room:7")).toMatchObject({ param: "7", def: app.channels["room:*"] });
    expect(matchChannel(app.channels, "other")).toBeNull();
    expect(matchChannel(app.channels, "room:has space")).toBeNull();
    expect(matchChannel(app.channels, "x".repeat(129))).toBeNull();
  });

  it("authorize: only a literal true allows; a throw refuses", () => {
    const req = { name: "room:1", param: "1", shard: "global:main" };
    expect(authorizeChannel(app.channels["room:*"]!, { subject: "a" }, req)).toBe(true);
    expect(authorizeChannel(app.channels["room:*"]!, null, req)).toBe(false);
    expect(authorizeChannel({ authorize: () => "yes" as unknown as boolean }, null, req)).toBe(false);
    expect(
      authorizeChannel(
        {
          authorize: () => {
            throw new Error("boom");
          },
        },
        null,
        req,
      ),
    ).toBe(false);
  });

  it("payload and state validators", () => {
    const typed = app.channels.typed!;
    expect(checkChannelValue(typed, "payload", { x: 1 })).toBeNull();
    expect(checkChannelValue(typed, "payload", { x: "1" })).toMatch(/^payload\.x: /);
    expect(checkChannelValue(typed, "state", undefined)).toBeNull();
    expect(checkChannelValue(typed, "state", { name: 1 })).toMatch(/^state\.name: /);
    expect(checkChannelValue(app.channels["room:*"]!, "payload", { anything: true })).toBeNull();
  });

  it("refuses bad declarations", () => {
    expect(() => defineApp({ channels: { "bad name": { authorize: () => true } } })).toThrow(/channel pattern/);
    expect(() => defineApp({ channels: { "a*b": { authorize: () => true } } })).toThrow(/channel pattern/);
    expect(() => defineApp({ channels: { room: {} as never } })).toThrow(/authorize/);
    expect(() => defineApp({ channels: { room: { authorize: () => true, extra: 1 } as never } })).toThrow(/unknown option/);
    expect(() => defineApp({ channels: { room: { authorize: () => true, payload: {} as never } } })).toThrow(/v\.\* validator/);
    expect(defineApp().channels).toEqual({});
  });
});
