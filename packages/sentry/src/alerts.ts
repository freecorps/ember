// Alerts of the sentry component: new issue, regression (a resolved issue seen again) and spike (N events in a window).
// Decided in the consumer's batch mutation (the same transaction as the issue write, so a redelivered batch does not
// alert twice for one state change), deduped per issue, throttled per issue and per project, then delivered by one
// `lib:deliver` job: signed webhooks and/or a mutation of the app (which sends them with the email or push component).

import { v, type Infer } from "@freecorps/ember-values";

export const alertValidator = v.object({
  kind: v.union(v.literal("new"), v.literal("regression"), v.literal("spike")),
  project: v.string(),
  issueId: v.string(),
  title: v.string(),
  culprit: v.string(),
  level: v.string(),
  /** Events of the issue so far. */
  count: v.number(),
  /** Spike: events in the current window. */
  windowCount: v.optional(v.number()),
  windowMinutes: v.optional(v.number()),
  release: v.string(),
  environment: v.string(),
  firstSeen: v.number(),
  lastSeen: v.number(),
  at: v.number(),
});
export type SentryAlert = Infer<typeof alertValidator>;

/** Args of the app's alert mutation: `internalMutation({ args: vAlertArgs, handler: (ctx, { alert }) => ... })`. */
export const vAlertArgs = { alert: alertValidator };

const KIND = { new: "New issue", regression: "Regression", spike: "Spike" } as const;

function headline(a: SentryAlert): string {
  const tail = a.kind === "spike" ? ` (${a.windowCount} events in ${a.windowMinutes} min)` : a.kind === "regression" ? " (seen again after it was resolved)" : "";
  return `[${a.project}] ${KIND[a.kind]}: ${a.title}${tail}`;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** An email for an alert (`email.send(ctx, { from, to, ...alertEmail(alert) })`). */
export function alertEmail(a: SentryAlert, o: { link?: string } = {}): { subject: string; text: string; html: string } {
  const rows: Array<[string, string]> = [
    ["Project", a.project],
    ["Level", a.level],
    ["Where", a.culprit || "-"],
    ["Release", a.release || "-"],
    ["Environment", a.environment || "-"],
    ["Events", String(a.count)],
    ["First seen", new Date(a.firstSeen).toISOString()],
    ["Last seen", new Date(a.lastSeen).toISOString()],
  ];
  const subject = headline(a).slice(0, 200);
  const text = [subject, "", ...rows.map(([k, val]) => `${k}: ${val}`), ...(o.link ? ["", o.link] : [])].join("\n");
  const html = `<h2>${escape(subject)}</h2><table>${rows.map(([k, val]) => `<tr><th align="left">${escape(k)}</th><td>${escape(val)}</td></tr>`).join("")}</table>${o.link ? `<p><a href="${escape(o.link)}">Open the issue</a></p>` : ""}`;
  return { subject, text, html };
}

/** A push notification for an alert (`push.send(ctx, { userIds, ...alertPush(alert) })`). */
export function alertPush(a: SentryAlert): { title: string; body: string; data: Record<string, string> } {
  return { title: `${KIND[a.kind]} · ${a.project}`, body: `${a.title}${a.kind === "spike" ? ` · ${a.windowCount} events` : ""}`.slice(0, 180), data: { kind: a.kind, project: a.project, issueId: a.issueId } };
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export async function signWebhook(secret: string, body: string, nowMs: number): Promise<string> {
  const t = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Checks a webhook signature (for receivers): constant time, and not older than `toleranceMs` (default 5 min). */
export async function verifyWebhook(secret: string, body: string, header: string | null, nowMs = Date.now(), toleranceMs = 300_000): Promise<boolean> {
  const m = header ? /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header) : null;
  if (!m) return false;
  if (Math.abs(nowMs - Number(m[1]) * 1000) > toleranceMs) return false;
  const want = (await signWebhook(secret, body, Number(m[1]) * 1000)).split("v1=")[1]!;
  let d = 0;
  for (let i = 0; i < 64; i++) d |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return d === 0;
}

/** Posts an alert to one webhook. Returns the HTTP status (0 on a network error). */
export async function postWebhook(url: string, alert: SentryAlert, secret: string | undefined, nowMs: number, fetchImpl: typeof fetch = fetch): Promise<number> {
  const body = JSON.stringify({ type: "ember.sentry.alert", alert });
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "ember-sentry" };
  if (secret) headers["x-ember-sentry-signature"] = await signWebhook(secret, body, nowMs);
  try {
    const res = await fetchImpl(url, { method: "POST", headers, body });
    await res.body?.cancel();
    return res.status;
  } catch (e) {
    console.error(`ember-sentry: webhook ${url} failed: ${(e as Error).message}`);
    return 0;
  }
}
