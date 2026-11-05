// Remote probes for PLAN §18 R12 (APNs HTTP/2 + ES256 from a Worker), R14 (HEIC via the Images binding) and R15 (Cron
// Trigger limits per Worker / account and fire timing). One throwaway Worker, `ember-spike-ops-probe`, deleted at the end.
//
//   bun run docs/spikes/remote/scripts/probes.ts <heic file> <png file>
//   bun run docs/spikes/remote/scripts/probes.ts --cron      (only R15 fire timing: waits up to 15 min for fires)
//
// The HEIC/PNG samples are made locally (`sips -s format heic -Z 1200 <img> --out sample.heic`) and never committed.
// Token: the CLI's lookup (wrangler OAuth), in memory only. Output is redacted.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { workerForm } from "../../../../packages/cli/src/deploy/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";

const cronOnly = process.argv[2] === "--cron";
const [heicPath, pngPath] = cronOnly ? [] : process.argv.slice(2);
if (!cronOnly && (!heicPath || !pngPath)) throw new Error("usage: probes.ts <heic> <png> | --cron");
const NAME = "ember-spike-ops-probe";
const token = resolveToken();
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${token}` } })).json()) as any).result[0].id as string;
const cf = new CfClient({ accountId: account, token });
const subdomain = ((await cf.request<{ subdomain?: string }>("GET", "/workers/subdomain")).result?.subdomain ?? "") as string;
const redact = (s: string) => s.split(account).join("<ACCOUNT_ID>").split(subdomain || "\u0000").join("<subdomain>").replace(/\/Users\/[^\s"']+/g, "<path>");
const lines: string[] = [];
const say = (...xs: unknown[]) => {
  const l = redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  lines.push(l);
  console.log(l);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const probeToken = randomBytes(24).toString("base64url");
const base = `https://${NAME}.${subdomain}.workers.dev`;
const get = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${probeToken}`, ...(init.headers ?? {}) } });
  return r.json();
};

const evidence: Record<string, unknown> = {};
try {
  // ---------------------------------------------------------------- deploy
  const code = readFileSync(join(import.meta.dir, "../workers/probe.js"), "utf8");
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: [],
    bindings: [
      { type: "durable_object_namespace", name: "LOG", class_name: "Log" },
      { type: "images", name: "IMAGES" },
      { type: "secret_text", name: "PROBE_TOKEN", text: probeToken },
    ],
    exports: { Log: { type: "durable-object", storage: "sqlite", state: "created" } },
    observability: { enabled: false },
  };
  await cf.call("PUT", `/workers/scripts/${NAME}`, workerForm(metadata as any, code));
  await cf.call("POST", `/workers/scripts/${NAME}/subdomain`, { enabled: true, previews_enabled: false });
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/es256`, { headers: { authorization: `Bearer ${probeToken}` } }).catch(() => null);
    if (r?.status === 200) break;
    await sleep(2000);
  }
  say("deployed", NAME);
  if (cronOnly) {
    await cf.call("PUT", `/workers/scripts/${NAME}/schedules`, [{ cron: "* * * * *" }]);
    const t0 = Date.now();
    say("R15: * * * * * set; polling fires for up to 15 min (trigger changes propagate slowly)");
    let fires: Array<{ scheduled: number; at: number }> = [];
    while (Date.now() - t0 < 15 * 60_000) {
      await sleep(60_000);
      fires = (await get("/fires")) as typeof fires;
      say(`  ${Math.round((Date.now() - t0) / 1000)} s: ${fires.length} fire(s)`);
      if (fires.length >= 6) break;
    }
    const delays = fires.map((f) => f.at - f.scheduled).sort((a, b) => a - b);
    const first = fires[0] ? Math.round((fires[0].scheduled - t0) / 1000) : null;
    say("R15 fires:", { count: fires.length, firstFireAfterSetS: first, delaysMs: delays, minutes: fires.map((f) => new Date(f.scheduled).toISOString().slice(11, 19)) });
    evidence.r15cron = { count: fires.length, firstFireAfterSetS: first, delaysMs: delays };
  } else {

  // ---------------------------------------------------------------- R15: cron limits
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id);
  let accountCrons = 0;
  for (const s of scripts) {
    if (s === NAME) continue;
    const r = await cf.request<{ schedules: unknown[] }>("GET", `/workers/scripts/${s}/schedules`);
    accountCrons += r.result?.schedules?.length ?? 0;
  }
  say(`R15: ${scripts.length - 1} other scripts in the account use ${accountCrons} cron trigger(s)`);
  const crons = (n: number) => Array.from({ length: n }, (_, i) => ({ cron: `${i % 60} ${Math.floor(i / 60) % 24} * * *` }));
  const tries: Record<string, unknown> = {};
  for (const n of [1, 3, 4, 5, 10, 20, 50]) {
    const r = await cf.request("PUT", `/workers/scripts/${NAME}/schedules`, crons(n));
    tries[n] = r.success ? "ok" : (r.errors as any[]).map((e) => `${e.code}: ${e.message}`).join("; ");
    if (!r.success) break;
  }
  say("R15 schedules per Worker:", tries);
  const odd: Record<string, unknown> = {};
  for (const [label, body] of [
    ["seconds field (6 fields)", [{ cron: "*/30 * * * * *" }]],
    ["CRON_TZ prefix", [{ cron: "CRON_TZ=America/Sao_Paulo 0 9 * * *" }]],
    ["L / W / # (Quartz extensions)", [{ cron: "0 9 L * *" }, { cron: "0 9 * * 1#2" }]],
    ["duplicate expression", [{ cron: "* * * * *" }, { cron: "* * * * *" }]],
  ] as const) {
    const r = await cf.request("PUT", `/workers/scripts/${NAME}/schedules`, body);
    odd[label] = r.success ? `ok ${JSON.stringify((r.result as any)?.schedules?.map((s: any) => s.cron))}` : (r.errors as any[]).map((e) => `${e.code}: ${e.message}`).join("; ");
  }
  say("R15 expression support:", odd);
  evidence.r15 = { otherScripts: scripts.length - 1, accountCrons, perWorker: tries, expressions: odd };

  // Fire timing: every minute for ~4 minutes (runs while the other probes go).
  await cf.call("PUT", `/workers/scripts/${NAME}/schedules`, [{ cron: "* * * * *" }]);
  const cronStart = Date.now();
  say("R15: schedule set to * * * * *; collecting fires");

  // ---------------------------------------------------------------- R12: ES256 + APNs over HTTP/2
  const es = await get("/es256");
  say("R12 ES256 in the Worker:", es && { sigBytes: (es as any).sigBytes, verified: (es as any).verified, ms: (es as any).ms });
  const ap = await get("/apns");
  say("R12 APNs from the Worker (bogus provider token):", ap);
  const expo = await get("/expo");
  say("R12 Expo Push from the Worker (invalid device token):", expo);
  evidence.r12 = { es256: { sigBytes: (es as any).sigBytes, verified: (es as any).verified }, apns: ap, expo };

  // ---------------------------------------------------------------- R14: HEIC through the Images binding
  const heic = readFileSync(heicPath);
  const png = readFileSync(pngPath);
  const r14: Record<string, unknown> = {};
  for (const [label, bytes, fmt] of [
    ["heic → webp", heic, "image/webp"],
    ["heic → jpeg", heic, "image/jpeg"],
    ["heic → avif", heic, "image/avif"],
    ["png → webp (control)", png, "image/webp"],
  ] as const) {
    r14[label] = await get(`/image?format=${encodeURIComponent(fmt)}`, { method: "POST", body: bytes });
    say(`R14 ${label} (${bytes.length} bytes in):`, r14[label]);
  }
  evidence.r14 = { heicBytes: heic.length, pngBytes: png.length, results: r14 };

  // ---------------------------------------------------------------- R15: fires
  const wait = cronStart + 250_000 - Date.now();
  if (wait > 0) await sleep(wait);
  const fires = (await get("/fires")) as Array<{ scheduled: number; at: number; cron: string }>;
  const delays = fires.map((f) => f.at - f.scheduled).sort((a, b) => a - b);
  say("R15 fires (scheduledTime → handler Date.now()):", { count: fires.length, delaysMs: delays, minutes: fires.map((f) => new Date(f.scheduled).toISOString().slice(11, 19)) });
  evidence.r15 = { ...(evidence.r15 as object), fires: fires.length, delaysMs: delays };
  }
} finally {
  const r = await cf.request("DELETE", `/workers/scripts/${NAME}?force=true`);
  say(`DELETE ${NAME}:`, r.success ? "ok" : JSON.stringify(r.errors));
  const g = await cf.request("GET", `/workers/scripts/${NAME}/settings`);
  say(`GET ${NAME}/settings after delete:`, g.success ? "STILL EXISTS" : `${(g.errors as any)?.[0]?.code} (gone)`);
  const tag = cronOnly ? "probes-r15-cron" : "probes-r12-r14-r15";
  writeFileSync(join(import.meta.dir, `../evidence/${tag}.json`), redact(JSON.stringify(evidence, null, 2)));
  writeFileSync(join(import.meta.dir, `../evidence/${tag}.txt`), lines.join("\n") + "\n");
}
