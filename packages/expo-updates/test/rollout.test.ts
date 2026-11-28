// Deterministic rollouts: the bucket of an install is stable, uniform, monotonic in the percentage and independent
// between rollouts; plans resolve per install with the rollout sides that key the edge cache.
import { describe, expect, test } from "vitest";
import { inRollout, resolvePlan, rolloutBucket, type BranchPlan, type Plan, type PlanEntry } from "../src/index.ts";

const ids = Array.from({ length: 20_000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const entry = (uuid: string, rolloutPercent = 100): PlanEntry => ({
  kind: "update",
  uuid,
  createdAt: 1,
  runtimeVersion: "1",
  launchAsset: { sha256: "a".repeat(64), key: "k", contentType: "application/javascript" },
  assets: [],
  metadata: {},
  extra: {},
  rolloutPercent,
});
const branch = (name: string, head: PlanEntry | null, control: PlanEntry | null = null, paused = false): BranchPlan => ({ name, paused, head, control });
const plan = (b: BranchPlan | null, extra: Partial<Plan> = {}): Plan => ({ channel: "production", found: true, version: 3, paused: false, branch: b, rollout: null, ...extra });

describe("rollout buckets", () => {
  test("uniform: every percentage lands within 1.5 points over 20k installs", () => {
    for (const p of [1, 10, 25, 50, 90]) {
      const share = ids.filter((id) => inRollout(id, "update-1", p)).length / ids.length;
      expect(Math.abs(share * 100 - p)).toBeLessThan(1.5);
    }
    // Buckets cover 0..99 roughly evenly.
    const counts = new Array(100).fill(0);
    for (const id of ids) counts[rolloutBucket(id, "u")]++;
    expect(Math.min(...counts)).toBeGreaterThan(130);
    expect(Math.max(...counts)).toBeLessThan(270);
  });

  test("stable, monotonic in the percentage, independent between rollouts", () => {
    for (const id of ids.slice(0, 500)) {
      expect(rolloutBucket(id, "u1")).toBe(rolloutBucket(id, "u1"));
      // Raising the percentage only adds installs.
      for (let p = 0; p < 100; p += 7) if (inRollout(id, "u1", p)) expect(inRollout(id, "u1", p + 7)).toBe(true);
    }
    // Two rollouts of 50% overlap on about a quarter of installs (independent salts), not on half.
    const both = ids.filter((id) => inRollout(id, "u1", 50) && inRollout(id, "u2", 50)).length / ids.length;
    expect(Math.abs(both - 0.25)).toBeLessThan(0.02);
    expect(inRollout(null, "u1", 99)).toBe(false);
    expect(inRollout(null, "u1", 100)).toBe(true);
    expect(inRollout("x", "u1", 0)).toBe(false);
  });
});

describe("resolvePlan", () => {
  test("no channel, a paused channel or branch, no head: noUpdateAvailable", () => {
    expect(resolvePlan({ ...plan(null), found: false }, "c").outcome).toEqual({ type: "noUpdateAvailable" });
    expect(resolvePlan(plan(branch("main", entry("u1")), { paused: true }), "c").outcome.type).toBe("noUpdateAvailable");
    expect(resolvePlan(plan(branch("main", entry("u1"), null, true)), "c").outcome.type).toBe("noUpdateAvailable");
    expect(resolvePlan(plan(branch("main", null)), "c").outcome.type).toBe("noUpdateAvailable");
  });

  test("an update rollout splits installs between the head and the control update; sides key the cache", () => {
    const p = plan(branch("main", entry("new", 30), entry("old")));
    const r = ids.map((id) => resolvePlan(p, id));
    const got = r.filter((x) => x.outcome.type === "update" && x.outcome.update.uuid === "new").length / ids.length;
    expect(Math.abs(got - 0.3)).toBeLessThan(0.015);
    expect(new Set(r.map((x) => x.sides))).toEqual(new Set(["u1", "u0"]));
    for (const x of r) expect(x.outcome.type === "update" && x.outcome.update.uuid).toBe(x.sides === "u1" ? "new" : "old");
    // No control (the first update of the branch in a rollout): the rest get nothing.
    expect(resolvePlan(plan(branch("main", entry("new", 0))), ids[0]!).outcome.type).toBe("noUpdateAvailable");
    // A full head: no side at all.
    expect(resolvePlan(plan(branch("main", entry("new"))), ids[0]!)).toMatchObject({ sides: "" });
  });

  test("a branch rollout of the channel, and a rollback directive head", () => {
    const p = plan(branch("main", entry("m")), { rollout: { percent: 20, branch: branch("beta", { kind: "rollBackToEmbedded", uuid: "rb", createdAt: 9, rolloutPercent: 100 }) } });
    const r = ids.map((id) => resolvePlan(p, id));
    const beta = r.filter((x) => x.sides === "c1");
    expect(Math.abs(beta.length / ids.length - 0.2)).toBeLessThan(0.015);
    for (const x of beta) expect(x.outcome).toEqual({ type: "rollBackToEmbedded", commitTime: 9 });
    for (const x of r.filter((y) => y.sides === "c0")) expect(x.outcome.type === "update" && x.outcome.update.uuid).toBe("m");
  });
});
