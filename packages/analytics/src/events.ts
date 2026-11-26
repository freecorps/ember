// Events and their Analytics Engine data points (contracts.md "Analytics"). Pure module: no Cloudflare or Node APIs, so
// the component, the client and the tests share it.
//
// A batch is `{ events: [{ name, props?, ts?, anonymousId?, userId? }] }`. Everything is checked before anything is
// written: a batch is accepted whole or refused whole (`BatchError`), except for string props longer than the cap,
// which are cut (a beacon cannot be retried, and a long label is not worth losing the event over).

/** Events per batch. Analytics Engine takes 250 data points per Worker invocation: a batch stays well under it. */
export const MAX_EVENTS = 50;
/** Bytes of one batch body (the HTTP route refuses more with 413 before parsing). */
export const MAX_BODY_BYTES = 32 * 1024;
/** Props per event. */
export const MAX_PROPS = 20;
/** Characters of a string prop (longer ones are cut). */
export const MAX_PROP_LENGTH = 256;
/** Characters of `userId` (when it is taken from the batch, `trustClientUserId`) and of an identity subject kept. */
export const MAX_USER_ID_LENGTH = 128;
/** Bytes of the JSON of the props that no dimension or measure takes (blob7). */
export const MAX_EXTRA_BYTES = 2048;
/** A client `ts` this far in the past (or `MAX_FUTURE_MS` in the future) is replaced by the time the server got it. */
export const MAX_PAST_MS = 7 * 24 * 3600 * 1000;
export const MAX_FUTURE_MS = 3600 * 1000;
/** Dimensions (string props in blobs 8..20) and measures (number props in doubles 2..20) an install may declare. */
export const MAX_DIMENSIONS = 13;
export const MAX_MEASURES = 19;

/**
 * Event names: a letter, then letters, digits, space, `_ . : / -`, up to 64 characters, no trailing space. No quote
 * and no backslash can ever be part of one, so a name is safe inside an SQL string literal (sql.ts still escapes).
 */
export const EVENT_NAME = /^[A-Za-z](?:[A-Za-z0-9 _.:/-]{0,62}[A-Za-z0-9_.:/-])?$/;
/** Prop keys (also dimension and measure names): identifiers up to 40 characters. */
export const PROP_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** Anonymous ids: what the client generates (a UUID) or any opaque token of the same alphabet. */
export const ANONYMOUS_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

/** One event as a caller sends it. */
export interface EventInput {
  name: string;
  props?: Props;
  /** When it happened, ms since the epoch (the client's clock). Default: when the server got it. */
  ts?: number;
  anonymousId?: string;
  /** Only kept when the install trusts it (`trustClientUserId`) or from server code; an identity always wins. */
  userId?: string;
}

/** A checked event, ready to become a data point. */
export interface TrackedEvent {
  name: string;
  props: Props;
  ts: number;
  receivedAt: number;
  anonymousId: string;
  userId: string;
}

export class BatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchError";
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The props of one event, checked (and long strings cut). */
export function checkProps(x: unknown, at: string): Props {
  if (x === undefined || x === null) return {};
  if (!isObject(x)) throw new BatchError(`${at}.props must be an object`);
  const keys = Object.keys(x);
  if (keys.length > MAX_PROPS) throw new BatchError(`${at}.props has ${keys.length} keys (at most ${MAX_PROPS})`);
  const out: Props = {};
  for (const k of keys) {
    if (!PROP_KEY.test(k)) throw new BatchError(`${at}.props: invalid key ${JSON.stringify(k.slice(0, 50))} (use [A-Za-z_][A-Za-z0-9_]*, up to 40)`);
    const v = x[k];
    if (typeof v === "string") out[k] = v.length > MAX_PROP_LENGTH ? v.slice(0, MAX_PROP_LENGTH) : v;
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new BatchError(`${at}.props.${k} must be a finite number`);
      out[k] = v;
    } else if (typeof v === "boolean") out[k] = v;
    else throw new BatchError(`${at}.props.${k} must be a string, number or boolean (props are flat)`);
  }
  return out;
}

export interface CheckOptions {
  /** Server time (ms): `receivedAt`, and the reference for the `ts` window. */
  now: number;
  /** The signed-in caller's id (identity subject): it replaces any `userId` in the batch. */
  identity?: string | null;
  /** Keep a `userId` sent in the batch when there is no identity (default false: it is dropped). */
  trustUserId?: boolean;
  /** Most events (default `MAX_EVENTS`). */
  maxEvents?: number;
}

/** One event, checked. */
export function checkEvent(x: unknown, at: string, o: CheckOptions): TrackedEvent {
  if (!isObject(x)) throw new BatchError(`${at} must be an object`);
  for (const k of Object.keys(x)) {
    if (k !== "name" && k !== "props" && k !== "ts" && k !== "anonymousId" && k !== "userId") throw new BatchError(`${at}: unknown field ${JSON.stringify(k.slice(0, 50))}`);
  }
  const name = x.name;
  if (typeof name !== "string" || !EVENT_NAME.test(name)) {
    throw new BatchError(`${at}.name: invalid event name ${JSON.stringify(typeof name === "string" ? name.slice(0, 70) : name)} (a letter, then letters, digits, space and _ . : / -, up to 64)`);
  }
  const props = checkProps(x.props, at);
  let ts = o.now;
  if (x.ts !== undefined) {
    if (typeof x.ts !== "number" || !Number.isFinite(x.ts)) throw new BatchError(`${at}.ts must be a number (ms since the epoch)`);
    if (x.ts >= o.now - MAX_PAST_MS && x.ts <= o.now + MAX_FUTURE_MS) ts = Math.floor(x.ts);
  }
  let anonymousId = "";
  if (x.anonymousId !== undefined) {
    if (typeof x.anonymousId !== "string" || !ANONYMOUS_ID.test(x.anonymousId)) throw new BatchError(`${at}.anonymousId: invalid (use [A-Za-z0-9_-], up to 64)`);
    anonymousId = x.anonymousId;
  }
  let userId = "";
  if (x.userId !== undefined) {
    if (typeof x.userId !== "string" || !x.userId || x.userId.length > MAX_USER_ID_LENGTH) throw new BatchError(`${at}.userId must be a non-empty string up to ${MAX_USER_ID_LENGTH}`);
    if (o.trustUserId) userId = x.userId;
  }
  if (o.identity) userId = o.identity.slice(0, MAX_USER_ID_LENGTH);
  return { name, props, ts, receivedAt: o.now, anonymousId, userId };
}

/** A whole batch (`{ events: [...] }`), checked: all of it or a `BatchError`. */
export function checkBatch(body: unknown, o: CheckOptions): TrackedEvent[] {
  if (!isObject(body)) throw new BatchError("the batch must be an object { events: [...] }");
  for (const k of Object.keys(body)) if (k !== "events") throw new BatchError(`unknown field ${JSON.stringify(k.slice(0, 50))}`);
  const events = body.events;
  if (!Array.isArray(events)) throw new BatchError("events must be an array");
  const max = o.maxEvents ?? MAX_EVENTS;
  if (events.length === 0) throw new BatchError("events is empty");
  if (events.length > max) throw new BatchError(`events has ${events.length} items (at most ${max})`);
  return events.map((e, i) => checkEvent(e, `events[${i}]`, o));
}

/** Parses and checks a batch body (JSON text, as `text/plain` beacons send it). */
export function parseBatch(text: string, o: CheckOptions): TrackedEvent[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BatchError("the body is not JSON");
  }
  return checkBatch(body, o);
}

// ------------------------------------------------------------------------------------------------ data points

/** The point `writeDataPoint` takes (the Workers `AnalyticsEngineDataPoint`). */
export interface DataPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** The Analytics Engine binding, structurally (`env.<binding>`). */
export interface AnalyticsEngineDataset {
  writeDataPoint(point?: { indexes?: (string | null)[]; blobs?: (string | ArrayBuffer | null)[]; doubles?: number[] }): void;
}

/** Where props go: declared string props get a blob each, declared number props a double each, the rest JSON. */
export interface PointLayout {
  /** String props with a column of their own: blob8, blob9, ... (in this order, at most 13). */
  dimensions?: readonly string[];
  /** Number props with a column of their own: double2, double3, ... (in this order, at most 19). */
  measures?: readonly string[];
}

export interface PointContext extends PointLayout {
  /** The install (blob6): installs and apps that share a dataset stay apart. */
  install: string;
  /** "client" (the HTTP route) or "server" (`track` from an action). */
  source: "client" | "server";
  /** Two-letter country of the request (Cloudflare's `cf.country`), or "". */
  country?: string;
}

/**
 * The column layout (also what sql.ts reads):
 *
 *   index1  event name (Analytics Engine samples per index)
 *   blob1   event name            blob2  userId ("" if none)     blob3  anonymousId ("" if none)
 *   blob4   source                blob5  country                 blob6  install
 *   blob7   JSON of the props no dimension or measure took ({} → "")
 *   blob8.. the declared dimensions, in order ("" when absent; numbers and booleans as text)
 *   double1 the event's time (ms since the epoch)     double2.. the declared measures (0 when absent)
 */
export const BLOB = { name: 1, userId: 2, anonymousId: 3, source: 4, country: 5, install: 6, extra: 7, firstDimension: 8 } as const;

export function toDataPoint(e: TrackedEvent, c: PointContext): DataPoint {
  const dims = c.dimensions ?? [];
  const meas = c.measures ?? [];
  const extra: Props = {};
  const blobsDims = dims.map(() => "");
  const doubles = [e.ts, ...meas.map(() => 0)];
  for (const [k, v] of Object.entries(e.props)) {
    const d = dims.indexOf(k);
    if (d >= 0) {
      blobsDims[d] = String(v);
      continue;
    }
    const m = meas.indexOf(k);
    if (m >= 0 && typeof v === "number") {
      doubles[m + 1] = v;
      continue;
    }
    extra[k] = v;
  }
  let extraJson = Object.keys(extra).length ? JSON.stringify(extra) : "";
  if (extraJson.length > MAX_EXTRA_BYTES) {
    // Keep whole props, in order, while they fit (never a cut JSON).
    const kept: Props = {};
    for (const [k, v] of Object.entries(extra)) {
      kept[k] = v;
      if (JSON.stringify(kept).length > MAX_EXTRA_BYTES) {
        delete kept[k];
        break;
      }
    }
    extraJson = Object.keys(kept).length ? JSON.stringify(kept) : "";
  }
  return {
    indexes: [e.name],
    blobs: [e.name, e.userId, e.anonymousId, c.source, c.country ?? "", c.install, extraJson, ...blobsDims],
    doubles,
  };
}

/** Checks an install's layout: identifiers, no repeats, within the column counts. Throws `Error`. */
export function checkLayout(l: PointLayout): void {
  const dims = l.dimensions ?? [];
  const meas = l.measures ?? [];
  if (dims.length > MAX_DIMENSIONS) throw new Error(`analytics: at most ${MAX_DIMENSIONS} dimensions (blob8..blob20)`);
  if (meas.length > MAX_MEASURES) throw new Error(`analytics: at most ${MAX_MEASURES} measures (double2..double20)`);
  const seen = new Set<string>();
  for (const k of [...dims, ...meas]) {
    if (!PROP_KEY.test(k)) throw new Error(`analytics: invalid prop name ${JSON.stringify(k)} in dimensions/measures`);
    if (seen.has(k)) throw new Error(`analytics: prop ${k} is declared twice in dimensions/measures`);
    seen.add(k);
  }
}

/** The SQL column of a declared prop (`blob9`, `double3`), or null. */
export function columnOf(l: PointLayout, prop: string): string | null {
  const d = (l.dimensions ?? []).indexOf(prop);
  if (d >= 0) return `blob${BLOB.firstDimension + d}`;
  const m = (l.measures ?? []).indexOf(prop);
  if (m >= 0) return `double${m + 2}`;
  return null;
}
