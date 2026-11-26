/**
 * `@freecorps/ember-sentry/client`: a small error reporter for browsers and React Native, for apps that do not want the
 * official Sentry SDK (which is the main path: `@sentry/react` with the same DSN works as is). Builds envelopes and
 * posts them to `<mount>/api/<project>/envelope/` with the DSN's key in the query.
 *
 *   import { init, captureException } from "@freecorps/ember-sentry/client";
 *   init({ dsn: "https://<key>@app.example.com/sentry/web", release: "1.2.3" });
 */
import { serializeEnvelope } from "./envelope.ts";
import { eventFromError, eventId, type Level, type SentryEvent } from "./event.ts";

export interface ClientOptions {
  dsn: string;
  release?: string;
  environment?: string;
  /** Fraction of events sent (default 1). */
  sampleRate?: number;
  /** Global `error` and `unhandledrejection` handlers (default true). */
  globalHandlers?: boolean;
  /** Last chance to edit or drop (return null) an event. */
  beforeSend?: (event: SentryEvent) => SentryEvent | null;
  fetch?: typeof fetch;
}

interface Dsn {
  key: string;
  url: string;
}

let current: { o: ClientOptions; dsn: Dsn; off: () => void } | null = null;

/** `https://<key>@<host>/<path>/<project>` → the envelope URL and the key. */
export function parseDsn(dsn: string): Dsn {
  const u = new URL(dsn);
  const parts = u.pathname.split("/").filter(Boolean);
  const project = parts.pop();
  if (!u.username || !project) throw new Error(`ember-sentry: invalid DSN ${dsn}`);
  const base = `${u.protocol}//${u.host}${parts.length ? "/" + parts.join("/") : ""}`;
  return { key: u.username, url: `${base}/api/${project}/envelope/?sentry_key=${encodeURIComponent(u.username)}&sentry_version=7` };
}

export function init(o: ClientOptions): void {
  current?.off();
  const dsn = parseDsn(o.dsn);
  let off = () => {};
  const g = globalThis as { addEventListener?: (t: string, f: (e: unknown) => void) => void; removeEventListener?: (t: string, f: (e: unknown) => void) => void };
  if (o.globalHandlers !== false && typeof g.addEventListener === "function") {
    const onError = (e: unknown) => void captureException((e as { error?: unknown; message?: string }).error ?? (e as { message?: string }).message, { handled: false });
    const onRejection = (e: unknown) => void captureException((e as { reason?: unknown }).reason, { handled: false });
    g.addEventListener("error", onError);
    g.addEventListener("unhandledrejection", onRejection);
    off = () => {
      g.removeEventListener?.("error", onError);
      g.removeEventListener?.("unhandledrejection", onRejection);
    };
  }
  current = { o, dsn, off };
}

export function close(): void {
  current?.off();
  current = null;
}

/** Sends an error; resolves to the event id (or null when not initialized, sampled out or dropped). */
export function captureException(error: unknown, o: { level?: Level; tags?: Record<string, string>; extra?: Record<string, unknown>; handled?: boolean } = {}): Promise<string | null> {
  if (!current) return Promise.resolve(null);
  return send(eventFromError(error, { ...o, platform: "javascript", ...(current.o.release ? { release: current.o.release } : {}), ...(current.o.environment ? { environment: current.o.environment } : {}) }));
}

export function captureMessage(message: string, level: Level = "info"): Promise<string | null> {
  if (!current) return Promise.resolve(null);
  const c = current.o;
  return send({ event_id: eventId(), timestamp: Date.now() / 1000, platform: "javascript", level, message, ...(c.release ? { release: c.release } : {}), ...(c.environment ? { environment: c.environment } : {}) });
}

async function send(event: SentryEvent): Promise<string | null> {
  const c = current;
  if (!c || Math.random() >= (c.o.sampleRate ?? 1)) return null;
  const e = c.o.beforeSend ? c.o.beforeSend(event) : event;
  if (!e) return null;
  const id = e.event_id ?? eventId();
  const body = serializeEnvelope({ event_id: id, sent_at: new Date().toISOString(), sdk: { name: "ember-sentry.client", version: "1" } }, [{ header: { type: "event" }, payload: { ...e, event_id: id } }]);
  try {
    // text/plain keeps it a simple CORS request (no preflight), like the official SDKs.
    const res = await (c.o.fetch ?? fetch)(c.dsn.url, { method: "POST", body: body as BodyInit, headers: { "content-type": "text/plain;charset=UTF-8" }, keepalive: body.length < 60_000 });
    return res.ok ? id : null;
  } catch {
    return null;
  }
}
