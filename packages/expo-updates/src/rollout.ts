/**
 * Deterministic rollouts and the resolution of a channel's plan into what one install gets. Pure and synchronous (no
 * WebCrypto): the Worker runs it for every request, cached plan in hand, without a database.
 *
 * - A bucket is `0..99` from a stable hash of the install id (`eas-client-id`) and a salt: the update's id for an
 *   update rollout, `channel:<name>:<branch>` for a branch rollout. An install is in a rollout of `p`% when its bucket
 *   is `< p`, so raising `p` only adds installs (never moves one out), and two rollouts are independent.
 * - No install id (an old client, a custom fetch): never in a partial rollout (the safe side, deterministic).
 */
import type { Outcome, UpdateEntry } from "./protocol.ts";

/** FNV-1a 32 over the UTF-8 bytes, then MurmurHash3's fmix32 (avalanche): uniform enough for buckets of 1%. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The install's bucket (0..99) for one rollout. */
export const rolloutBucket = (clientId: string, salt: string): number => hash32(`${salt}\u0000${clientId}`) % 100;

/** Whether the install is in a rollout of `percent` (0..100). 100 = everyone, 0 = nobody, no id = nobody below 100. */
export function inRollout(clientId: string | null, salt: string, percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0 || clientId === null) return false;
  return rolloutBucket(clientId, salt) < percent;
}

/** A directive row of a branch: clients go back to the update embedded in the binary. */
export interface RollbackEntry {
  kind: "rollBackToEmbedded";
  uuid: string;
  createdAt: number;
}
export type PlanEntry = (UpdateEntry | RollbackEntry) & { rolloutPercent: number };

/** One branch of a plan: its newest live entry (`head`) and, while the head is in a partial rollout, what the rest get. */
export interface BranchPlan {
  name: string;
  paused: boolean;
  head: PlanEntry | null;
  /** The newest live entry before `head` (only read while `head.rolloutPercent < 100`). */
  control: PlanEntry | null;
}

/**
 * What a channel serves for one (platform, runtime version), as the `plan` query returns it: everything the Worker
 * needs to answer any install, so it is cached at the edge and resolved per request without the database. `version`
 * changes with every publish, rollback, rollout change and kill switch that can change the answer.
 */
export interface Plan {
  channel: string;
  /** The channel exists. */
  found: boolean;
  version: number;
  paused: boolean;
  branch: BranchPlan | null;
  /** A branch rollout of the channel: `percent`% of installs get `branch` instead. */
  rollout: { percent: number; branch: BranchPlan } | null;
}

export interface Resolution {
  outcome: Outcome;
  /**
   * Which side of each rollout the install fell on (`c1`: in the channel's branch rollout, `u0`: out of the head
   * update's rollout, ...): with the plan version, it fixes the outcome. Part of the edge cache key instead of the
   * install id: installs on the same side share a cached response.
   */
  sides: string;
}

const entryOutcome = (e: PlanEntry | null): Outcome =>
  !e ? { type: "noUpdateAvailable" } : e.kind === "rollBackToEmbedded" ? { type: "rollBackToEmbedded", commitTime: e.createdAt } : { type: "update", update: e };

/** Resolves a plan for one install (`clientId`: its install id, or null). */
export function resolvePlan(plan: Plan, clientId: string | null): Resolution {
  if (!plan.found || plan.paused || !plan.branch) return { outcome: { type: "noUpdateAvailable" }, sides: "" };
  let sides = "";
  let branch = plan.branch;
  if (plan.rollout && plan.rollout.percent > 0) {
    const inIt = inRollout(clientId, `channel:${plan.channel}:${plan.rollout.branch.name}`, plan.rollout.percent);
    sides += inIt ? "c1" : "c0";
    if (inIt) branch = plan.rollout.branch;
  }
  if (branch.paused || !branch.head) return { outcome: { type: "noUpdateAvailable" }, sides };
  const head = branch.head;
  if (head.rolloutPercent >= 100) return { outcome: entryOutcome(head), sides };
  const inIt = inRollout(clientId, head.uuid, head.rolloutPercent);
  sides += inIt ? "u1" : "u0";
  return { outcome: entryOutcome(inIt ? head : branch.control), sides };
}
