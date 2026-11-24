// `compactFormat` reaches every shard's engine (contracts.md "Armazenamento compacto", "Qual formato"): set by the app
// (`defineApp({ storage: { compactFormat } })`) or by the Worker entry (`createEmberWorker({ compactFormat })`), it decides
// the format of the tables a shard's migration creates. Default 3 (no `_k_by_creation_time` column, marker "3").
import { runInDurableObject } from "cloudflare:test";
import { defineApp, type SchemaManifest } from "@freecorps/ember-server";
import { afterEach, describe, expect, it } from "vitest";
import { compactFormatOf, setEmberConfig, type EmberConfig } from "../src/config.ts";
import { createEmberWorker } from "../src/index.ts";
import type { ShardPreflight } from "../src/admin-api.ts";
import { api, shardStub } from "./helpers.ts";
import { config, input } from "./worker.ts";

/** What a shard's boot wrote: the CREATE TABLE of `messages` and `_ember_meta.storage`. */
async function storageOf(shard: string) {
  expect((await api("mutation", { fn: "messages:send", args: { channel: "c", body: "hi" }, shard })).body.ok).toBe(true);
  return runInDurableObject(shardStub(shard), (_i, state) => {
    const sql = state.storage.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").one().sql as string;
    const marker = state.storage.sql.exec("SELECT value FROM _ember_meta WHERE key = 'storage'").toArray()[0]?.value ?? null;
    return { keyColumn: sql.includes("_k_by_creation_time"), marker };
  });
}

/** The config with the app's `defineApp({ storage })` (components, env and limits kept). */
const withAppStorage = (compactFormat: 2 | 3): EmberConfig => ({ ...config, app: { ...config.app!, storage: defineApp({ storage: { compactFormat } }).storage } });

describe("compactFormat", () => {
  afterEach(() => setEmberConfig(config));

  it("default: new tables are format 3 (no key column), marker 3", async () => {
    expect(await storageOf("cf:default")).toEqual({ keyColumn: false, marker: "3" });
  });

  it("createEmberWorker({ compactFormat: 2 }): new tables are format 2 (key column), marker 2", async () => {
    setEmberConfig({ ...config, compactFormat: 2 });
    expect(await storageOf("cf:config2")).toEqual({ keyColumn: true, marker: "2" });
  });

  it("defineApp({ storage: { compactFormat: 2 } }): the same, from the app", async () => {
    setEmberConfig(withAppStorage(2));
    expect(await storageOf("cf:app2")).toEqual({ keyColumn: true, marker: "2" });
  });

  it("preflight plans new tables in the configured format", async () => {
    setEmberConfig({ ...config, compactFormat: 2 });
    const shard = "cf:preflight";
    await storageOf(shard);
    const m = config.schema.manifest;
    const next: SchemaManifest = { ...m, version: `${m.version}-cf`, hash: `${m.hash}-cf`, tables: { ...m.tables, cfExtra: { ...m.tables.runs!, idPrefix: "cfx" } } };
    const pre = (await shardStub(shard).preflight(shard, next)) as ShardPreflight;
    const step = pre.result.status !== "unchecked" ? pre.result.steps.find((s) => s.op === "createTable" && s.table === "cfExtra") : undefined;
    expect(step).toMatchObject({ op: "createTable", compact: 2 });
  });

  it("precedence and validation: config over app, refused when they differ or out of range", () => {
    expect(compactFormatOf({})).toBeUndefined();
    expect(compactFormatOf({ compactFormat: 2 })).toBe(2);
    expect(compactFormatOf(withAppStorage(2))).toBe(2);
    expect(compactFormatOf({ ...withAppStorage(3), compactFormat: 3 })).toBe(3);
    // Checked by createEmberWorker before it installs the config.
    expect(() => createEmberWorker({ ...input, app: { ...input.app!, storage: { compactFormat: 3 } }, compactFormat: 2 })).toThrow(/compactFormat 2 differs/);
    expect(() => createEmberWorker({ ...input, compactFormat: 4 as 2 })).toThrow(/compactFormat must be 2 or 3/);
    // a BigInt is shown, not a TypeError from JSON.stringify
    expect(() => compactFormatOf({ compactFormat: 2n as unknown as 2 })).toThrow(/compactFormat must be 2 or 3 \(got 2\)/);
  });
});
