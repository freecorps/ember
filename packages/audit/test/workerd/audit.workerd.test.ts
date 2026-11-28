/**
 * The audit component in workerd: triggers write the audit rows in the mutation's transaction (a failed one leaves
 * none), and the daily cron, ticked through the real System DO, archives them to R2 (miniflare) in batches of 3 that
 * continue through the shard's scheduler: every row lands in exactly one object, then leaves the shard.
 */
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { gunzipNdjson, type AuditEntry } from "../../src/index.ts";

const call = async (kind: "query" | "mutation", fn: string, args: unknown, shard = "global:main") => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  return (await res.json()) as { ok: boolean; value?: any; error?: { message: string } };
};
const DAY = 86_400_000;

describe("audit in workerd", () => {
  it("triggers write in the transaction; the cron moves every row to R2 once, in batches, then deletes them", async () => {
    const added = await call("mutation", "api:add", { names: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(added.ok).toBe(true);
    const failed = await call("mutation", "api:addThenFail", { name: "ghost" });
    expect(failed.ok).toBe(false);
    const rows = (await call("query", "api:audit", {})).value as AuditEntry[];
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.op === "insert" && r.table === "users" && r.actor === "system")).toBe(true);
    expect(rows.map((r) => r.diff?.passwordHash)).toEqual(Array(7).fill({ to: "[redacted]" }));
    const ids = rows.map((r) => r._id).sort();

    // The daily cron (03:00 UTC), on a day in the past so the job it dispatches is due now.
    const system = env.SYSTEM.get(env.SYSTEM.idFromName("system"));
    const tick = await system.tick(Math.floor(Date.now() / DAY) * DAY - 2 * DAY + 3 * 3_600_000);
    expect(tick.dispatched.map((d) => d.name)).toEqual(["@audit/archive"]);
    // The shard runs the action job, whose delete schedules the next batch, until the backlog is gone.
    const shard = env.SHARD.get(env.SHARD.idFromName("global:main"));
    for (let i = 0; i < 20 && ((await call("query", "api:audit", {})).value as unknown[]).length; i++) {
      await runDurableObjectAlarm(shard);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await call("query", "api:audit", {})).value).toEqual([]);

    const listed = await env.EMBER_FILES.list({ prefix: "audit/audit/", include: ["customMetadata"] });
    expect(listed.objects.map((o) => Number(o.customMetadata?.count)).sort()).toEqual([1, 3, 3]);
    const archived: string[] = [];
    for (const o of listed.objects) {
      expect(o.key).toMatch(/^audit\/audit\/\d{4}\/\d{2}\/\d{2}\/\d+-[0-9a-f]{8}\.ndjson\.gz$/);
      const obj = await env.EMBER_FILES.get(o.key);
      expect(obj?.httpMetadata?.contentEncoding).toBe("gzip");
      archived.push(...((await gunzipNdjson(await obj!.arrayBuffer())) as AuditEntry[]).map((e) => e._id));
    }
    expect(archived.sort()).toEqual(ids);
  });
});
