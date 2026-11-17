// `ember deploy --preflight`: before anything is uploaded, ask each live shard what its migration planner would do
// with the schema about to be deployed (`POST /api/_ember/preflight`, contracts.md "Deploy"). The plan runs in the
// shard, with the deployed runtime's planner and index kinds, against the shard's data, in a transaction that is
// rolled back: nothing is written. Exit 1 when any shard would refuse the schema or could not be checked.

import { checkCredentialUrl } from "../secure-url.ts";

export type PreflightStep = { op: string; table: string; field?: string; index?: string; kind?: string; staged?: boolean; reason?: string };

export type PreflightResult =
  | {
      status: "ok" | "refused";
      fromVersion: string | null;
      toVersion: string;
      changed: boolean;
      steps: PreflightStep[];
      staged: Array<{ table: string; index: string; kind: string }>;
      conversions: Array<{ table: string; skipped?: string }>;
    }
  | { status: "unchecked"; code: string; message: string };

/** One shard's answer (`ShardPreflight` of the runtime, plus what the Worker adds). */
export type ShardPreflight = {
  shard: string;
  schemaVersion: string | null;
  refused: { code: string; message: string } | null;
  result: PreflightResult;
  runtime: string | null;
  deployedVersion: string;
};

export type PreflightOutcome =
  | { shard: string; state: "ok" | "refused" | "unchecked"; answer: ShardPreflight }
  | { shard: string; state: "error"; error: string };

export type PreflightReport = {
  /** The deployed runtime has no preflight endpoint: nothing was checked. */
  tooOld?: { level: number };
  outcomes: PreflightOutcome[];
  /** 0 only when every shard was checked and none would refuse. */
  exitCode: 0 | 1;
};

export interface PreflightOptions {
  /** Deployment base URL. */
  url: string;
  adminToken: string;
  /** The schema manifest about to be deployed (`ember codegen`). */
  schema: { version: string };
  /** Only these shards (`--shard`); default: every shard of `catalog`. `global:main` is always checked. */
  shards?: string[];
  /** The registry's shard catalog for this environment (undefined: none, e.g. a `--url` without `--env`). */
  catalog?: () => Promise<string[]>;
  /** The Ember runtime version this deploy would ship (to warn when the deployed planner is another release). */
  localRuntime?: string | null;
  concurrency?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** Admin feature the endpoint is listed under in `GET /api/_ember/capabilities`. */
export const PREFLIGHT_FEATURE = "preflight";

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

type Body = { ok?: boolean; value?: unknown; error?: { code?: string; message?: string }; level?: unknown; features?: unknown };

async function getJson(res: Response): Promise<Body | null> {
  try {
    return (await res.json()) as Body;
  } catch {
    return null;
  }
}

function tokenError(res: Response, body: Body | null): Error | null {
  if (res.status === 403 && body?.error?.code === "admin_disabled")
    return new Error("The Worker has no EMBER_ADMIN_TOKEN: deploy once with EMBER_ADMIN_TOKEN set (it is uploaded as a secret) or set the secret by hand.");
  if (res.status === 401) return new Error("The Worker rejected the admin token (EMBER_ADMIN_TOKEN, or --admin-token, differs from the deployed secret).");
  return null;
}

/** The deployed runtime's admin level and whether it serves the preflight endpoint (a 404 is level 1, before capabilities). */
export async function preflightSupport(o: Pick<PreflightOptions, "url" | "adminToken" | "fetch">): Promise<{ supported: boolean; level: number }> {
  checkCredentialUrl(o.url);
  const res = await (o.fetch ?? fetch)(new URL("/api/_ember/capabilities", o.url), { headers: { authorization: `Bearer ${o.adminToken}` } });
  const body = await getJson(res);
  const bad = tokenError(res, body);
  if (bad) throw bad;
  if (res.status === 404) return { supported: false, level: 1 };
  if (!res.ok || !body?.ok) throw new Error(`GET /api/_ember/capabilities answered HTTP ${res.status}`);
  const features = Array.isArray(body.features) ? body.features : [];
  return { supported: features.includes(PREFLIGHT_FEATURE), level: Number(body.level) || 2 };
}

async function shardsToCheck(o: PreflightOptions, log: (l: string) => void): Promise<{ shards: string[]; unknown: string[] }> {
  if (o.shards?.length) {
    const asked = [...new Set(["global:main", ...o.shards])];
    if (!o.catalog) return { shards: asked, unknown: [] };
    // Waking a shard that never existed would create it: only shards the catalog knows are asked.
    const known = new Set(await o.catalog());
    known.add("global:main");
    return { shards: asked.filter((s) => known.has(s)), unknown: asked.filter((s) => !known.has(s)) };
  }
  if (!o.catalog) {
    log("  no registry catalog for this target: checking global:main only (pass --env, or --shard kind:key)");
    return { shards: ["global:main"], unknown: [] };
  }
  return { shards: [...new Set(["global:main", ...(await o.catalog())])], unknown: [] };
}

async function askShard(o: PreflightOptions, shard: string): Promise<PreflightOutcome> {
  try {
    const res = await (o.fetch ?? fetch)(new URL("/api/_ember/preflight", o.url), {
      method: "POST",
      headers: { authorization: `Bearer ${o.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ shard, schema: o.schema }),
    });
    const body = await getJson(res);
    const bad = tokenError(res, body);
    if (bad) return { shard, state: "error", error: bad.message };
    if (!res.ok || !body?.ok || !body.value) return { shard, state: "error", error: `HTTP ${res.status}: ${body?.error?.code ?? "error"}: ${body?.error?.message ?? "no answer"}` };
    const answer = body.value as ShardPreflight;
    return { shard, state: answer.result.status, answer };
  } catch (e) {
    return { shard, state: "error", error: (e as Error).message };
  }
}

const DESTRUCTIVE = new Set(["dropColumn", "dropIndex", "rebuildTable"]);

function describeStep(s: PreflightStep): string {
  const what = [s.table, s.field ?? s.index].filter(Boolean).join(".");
  const extra = s.op === "createIndex" ? ` (${s.kind}${s.staged ? ", staged backfill" : ""})` : "";
  return `${s.op} ${what}${extra}${s.reason ? `: ${s.reason}` : ""}`;
}

/** Lines for one shard (also used by tests). */
export function formatOutcome(x: PreflightOutcome): string[] {
  if (x.state === "error") return [`  ✗ ${x.shard}: cannot check: ${x.error}`];
  const a = x.answer;
  const r = a.result;
  const out: string[] = [];
  const now = a.refused ? ` (refusing the deployed schema now: ${a.refused.code})` : "";
  if (r.status === "unchecked") return [`  ✗ ${x.shard}: cannot check: ${r.code}: ${r.message}${now}`];
  const from = r.fromVersion?.slice(0, 12) ?? "none";
  if (r.status === "refused") {
    out.push(`  ✗ ${x.shard}: would REFUSE schema ${from} → ${r.toVersion.slice(0, 12)}${now}`);
    for (const s of r.steps.filter((s) => s.op === "refuse")) out.push(`      ${s.table}${s.field ? `.${s.field}` : ""}: ${s.reason}`);
    return out;
  }
  if (!r.changed) out.push(`  ✓ ${x.shard}: schema unchanged (${from})${now}`);
  else {
    const counted = r.steps.filter((s) => s.op !== "noop");
    out.push(`  ✓ ${x.shard}: ${from} → ${r.toVersion.slice(0, 12)}: ${counted.length} step(s)${r.staged.length ? `, ${r.staged.length} staged index backfill(s)` : ""}${now}`);
    for (const s of r.steps) out.push(`      ${DESTRUCTIVE.has(s.op) ? "! " : ""}${describeStep(s)}`);
  }
  for (const c of r.conversions) out.push(`      convert ${c.table} to compact storage${c.skipped ? ` (not yet: ${c.skipped})` : ""}`);
  return out;
}

export async function preflightDeploy(opts: PreflightOptions): Promise<PreflightReport> {
  // Checked before the first request (the CLI's resolveBaseUrl checks too; this is for other callers), and every
  // request below reads this copy, so the URL that was checked is the one the token goes to.
  checkCredentialUrl(opts.url);
  const o = { ...opts };
  const log = o.log ?? ((l: string) => console.log(l));
  log(`Preflight: schema ${o.schema.version.slice(0, 12)} against ${o.url} (nothing is uploaded or written)`);
  const support = await preflightSupport(o);
  if (!support.supported) {
    log(`  ✗ the deployed runtime is too old to preflight (admin API level ${support.level}; POST /api/_ember/preflight is missing): nothing was checked`);
    return { tooOld: { level: support.level }, outcomes: [], exitCode: 1 };
  }
  const { shards, unknown } = await shardsToCheck(o, log);
  const outcomes: PreflightOutcome[] = [
    ...unknown.map((shard): PreflightOutcome => ({ shard, state: "error", error: "not in the registry catalog (asking it would create the shard)" })),
    ...(await pool(shards, o.concurrency ?? 8, (s) => askShard(o, s))),
  ];
  for (const x of outcomes) for (const l of formatOutcome(x)) log(l);
  const runtimes = [...new Set(outcomes.flatMap((x) => (x.state !== "error" && x.answer.runtime ? [x.answer.runtime] : [])))];
  if (o.localRuntime && runtimes.some((r) => r !== o.localRuntime)) {
    log(`  note: the plan comes from the deployed runtime (${runtimes.join(", ")}); this deploy ships ${o.localRuntime}, whose planner may decide differently`);
  }
  const bad = outcomes.filter((x) => x.state !== "ok");
  const refused = bad.filter((x) => x.state === "refused").length;
  log(
    bad.length
      ? `Preflight failed: ${refused} shard(s) would refuse, ${bad.length - refused} could not be checked (of ${outcomes.length})`
      : `Preflight passed: ${outcomes.length} shard(s) would accept schema ${o.schema.version.slice(0, 12)}`,
  );
  return { outcomes, exitCode: bad.length ? 1 : 0 };
}
