/**
 * `@freecorps/ember-sentry`: error tracking as an Ember component, compatible with the Sentry Envelope API (PLAN §12;
 * contracts.md "Sentry").
 *
 *   // ember/ember.config.ts
 *   export default defineApp({ onError: sentryErrorReporter({ project: "web" }) })   // optional: Ember's own errors
 *     .use(sentry, { config: { projects: [{ id: "web", keys: ["<public key>"] }], alerts: { webhooks: [{ url, secretEnv: "ALERT_SECRET" }] } } });
 *
 *   // the app: Sentry.init({ dsn: "https://<public key>@<host>/sentry/web" })   (@sentry/react, react-native, cloudflare)
 *   // CI:      ember sentry sourcemaps upload --project web --release 1.2.3 dist/
 *
 * Ingest writes no Durable Object row: events go through the component's Queue to a consumer that writes one row per
 * issue per batch; payloads go gzipped to R2; time series to Analytics Engine.
 */
import { unsafeRef, type ActionCtx, type FunctionReference } from "@freecorps/ember-server";
import { queueBinding, type QueueLike } from "./config.ts";
import { eventFromError, eventId, type Level, type SentryEvent } from "./event.ts";
import type { QueuedEvent } from "./ingest.ts";

export { sentry, functions as sentryFunctions, ROUTES, bumpHourly, sha256Hex, type SentryConfig } from "./component.ts";
export { installConfigValidator, alertsValidator, projectValidator, queueBinding, analyticsBinding, DEFAULT_LIMITS, DEFAULT_RETENTION_DAYS, DEFAULT_DATASET, type SentryInstallConfig, type SentryProjectConfig, type SentryAlertsConfig, type R2Like, type QueueLike, type AnalyticsEngineLike } from "./config.ts";
export { parseEnvelope, serializeEnvelope, decodeBody, EnvelopeError, gzip, gunzip, type Envelope, type EnvelopeItem } from "./envelope.ts";
export { handleIngest, keyFromRequest, keyFromDsn, projectFromPath, TokenBuckets, rateLimitHeaders, type IngestDeps, type QueuedEvent } from "./ingest.ts";
export { consume, type ConsumerDeps, type ConsumeResult, type IssueGroup } from "./consumer.ts";
export { decodeMappings, parseSourceMap, sourceComments, normalizeDebugId, type SourceMap, type OriginalPosition } from "./sourcemap.ts";
export { symbolicate, Lru, mapCache } from "./symbolicate.ts";
export { fingerprintOf, groupingComponents, titleOf, culpritOf, stackText, parseStack, artifactName, eventFromError, type SentryEvent, type StackFrame, type Level } from "./event.ts";
export { alertEmail, alertPush, alertValidator, vAlertArgs, signWebhook, verifyWebhook, type SentryAlert } from "./alerts.ts";
export { keys as storageKeys, sweepExpired, readEvent, batchObject } from "./storage.ts";

/** What `components.<name>` of the sentry component looks like (structural: any install name). */
export interface SentryComponentApi {
  lib: {
    setStatus: FunctionReference<"mutation", "public", { id: string; status: "unresolved" | "resolved" | "ignored" }, string>;
    issue: FunctionReference<"query", "public", { id: string }, unknown>;
    capture: FunctionReference<"action", "public", { project?: string; event: unknown }, string>;
    latestEvent: FunctionReference<"action", "public", { id: string }, unknown>;
  };
}

export interface CaptureOptions {
  /** The project (default: the install's first). */
  project?: string;
  level?: Level;
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Reports an error from an action or an httpAction: `await sentryCapture(ctx, components.sentry, e)`. The event goes
 * straight to the component's queue (no shard write). Returns the event id. Mutations and queries cannot do I/O
 * (PLAN D6): let the error throw (and turn on `sentryErrorReporter`), or schedule an action.
 */
export async function sentryCapture(ctx: Pick<ActionCtx, "runAction">, component: SentryComponentApi, error: unknown, o: CaptureOptions = {}): Promise<string> {
  const { project, ...rest } = o;
  const event = eventFromError(error, { ...rest, platform: "node" });
  return ctx.runAction(component.lib.capture, { ...(project ? { project } : {}), event });
}

/** Reports a whole event (`message` events, custom fingerprints) the same way. */
export async function sentryCaptureEvent(ctx: Pick<ActionCtx, "runAction">, component: SentryComponentApi, event: SentryEvent, o: { project?: string } = {}): Promise<string> {
  return ctx.runAction(component.lib.capture, { ...(o.project ? { project: o.project } : {}), event });
}

/** An error the Ember runtime saw a function throw (`defineApp({ onError })`). */
export interface FunctionErrorReport {
  fn: string;
  kind: string;
  shard: string;
  code: string;
  message: string;
  stack?: string;
  at: number;
}

/**
 * `defineApp({ onError: sentryErrorReporter({ project: "api" }) })`: every unhandled error of an Ember function
 * (not application errors from `defineErrors`, not validation or auth refusals) becomes an event of that project,
 * sent to the install's queue from wherever it happened (Worker or shard). Off when the app does not pass it.
 */
export function sentryErrorReporter(o: { project: string; install?: string; release?: string; environment?: string }): (report: FunctionErrorReport, env: Record<string, unknown>) => Promise<void> {
  const binding = queueBinding(o.install ?? "sentry");
  return async (r, env) => {
    const q = env[binding] as QueueLike | undefined;
    if (!q || typeof q.send !== "function") return;
    const err = Object.assign(new Error(r.message), { name: r.code });
    if (r.stack) err.stack = r.stack;
    else delete (err as { stack?: string }).stack;
    const event = eventFromError(err, { platform: "node", now: r.at, handled: false, tags: { "ember.function": r.fn, "ember.kind": r.kind, "ember.shard": r.shard }, ...(o.release ? { release: o.release } : {}), ...(o.environment ? { environment: o.environment } : {}) });
    // Grouped by function and error, wherever the stack is (the runtime may not have one).
    event.fingerprint = ["{{ default }}", r.fn];
    event.transaction = r.fn;
    const msg: QueuedEvent = { v: 1, project: o.project, id: event.event_id ?? eventId(), receivedAt: r.at, event };
    await q.send(msg, { contentType: "json" });
  };
}

/** By-name reference to the install's capture action (when the typed `components` is not at hand). */
export const captureRef = (install = "sentry") => unsafeRef<"action">(`@${install}/lib:capture`);
