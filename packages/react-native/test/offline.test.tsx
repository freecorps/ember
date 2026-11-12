import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { unsafeRef } from "@freecorps/ember-client";
import { expoSqliteStorage, type ExpoSqliteDatabase } from "@freecorps/ember-offline/expo-sqlite";
import { defineSchema, defineTable, v, type SqlValue } from "@freecorps/ember-server";
import { afterEach, describe, expect, it } from "vitest";
import { EmberProvider, createEmberClient, useQuerySnapshot } from "../src/index.ts";

/** expo-sqlite's synchronous API over node:sqlite (the adapter's real SQL path). */
class NodeExpoDatabase implements ExpoSqliteDatabase {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }
  getAllSync(sql: string, params: SqlValue[]) {
    return this.db.prepare(sql).all(...(params as any[]));
  }
  runSync(sql: string, params: SqlValue[]) {
    return { changes: Number(this.db.prepare(sql).run(...(params as any[])).changes) };
  }
  execSync(sql: string) {
    this.db.exec(sql);
  }
  closeSync() {
    this.db.close();
  }
}

const dirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function List() {
  const s = useQuerySnapshot(unsafeRef<"query">("messages:list"), { channel: "a" });
  return <div data-testid="list">{s.status === "success" ? `${(s.value as string[]).join(",")}|${s.source ?? "server"}` : s.status}</div>;
}

describe("createEmberClient with expo-sqlite offline storage", () => {
  it("persists results on the device and renders them offline after a restart", async () => {
    const server = new FakeEmberServer({
      queries: { "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body) },
      mutations: { "messages:send": (db, args) => db.insert("messages", args) },
    });
    server.mutateDirect("org:acme", "messages:send", { channel: "a", body: "hi" });
    const dir = mkdtempSync(join(tmpdir(), "ember-rn-"));
    dirs.push(dir);
    const schema = defineSchema({ tables: { messages: defineTable({ channel: v.string(), body: v.string() }) } });
    const make = (online: boolean) =>
      createEmberClient({
        url: "https://ember.test",
        WebSocket: server.WebSocket,
        fetch: server.fetch,
        defaultShard: "org:acme",
        heartbeat: false,
        connectivity: { isOnline: () => online, subscribe: () => () => {} },
        storage: expoSqliteStorage({ schema, openDatabaseSync: (n) => new NodeExpoDatabase(join(dir, n)) }),
      });

    const c1 = make(true);
    render(<EmberProvider client={c1}><List /></EmberProvider>);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("hi|server"));
    await c1.flushStorage();
    cleanup();
    c1.close();

    const c2 = make(false);
    render(<EmberProvider client={c2}><List /></EmberProvider>);
    await waitFor(() => expect(screen.getByTestId("list").textContent).toBe("hi|cache"));
    c2.close();
  });
});
