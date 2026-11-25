/**
 * Tiny dependency-free 5-field cron parser with IANA time zones (via Intl).
 *
 *   minute hour day-of-month month day-of-week
 *
 * Supports `*`, lists `a,b`, ranges `a-b`, steps `*\/n` and `a-b/n`, month and
 * weekday names (JAN..DEC, SUN..SAT), 7 as Sunday, and the macros
 * @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly.
 * Day-of-month and day-of-week follow Vixie semantics: when both are
 * restricted, a day matches if either matches.
 *
 * DST: a local time skipped by a spring-forward never matches; a repeated
 * local time during fall-back matches twice.
 */

export interface CronExpr {
  source: string;
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export class CronParseError extends Error {
  override name = "CronParseError";
}

function parseField(field: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const value = (s: string): number => {
    const upper = s.toUpperCase();
    if (names) {
      const i = names.indexOf(upper);
      if (i >= 0) return i + nameBase;
    }
    if (!/^\d+$/.test(s)) throw new CronParseError(`invalid value "${s}"`);
    const n = Number(s);
    if (n < min || n > max) throw new CronParseError(`value ${n} out of range ${min}-${max}`);
    return n;
  };
  for (const part of field.split(",")) {
    if (part === "") throw new CronParseError(`empty list item in "${field}"`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new CronParseError(`invalid step in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new CronParseError(`invalid step in "${part}"`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart!.includes("-")) {
      const [a, b, more] = rangePart!.split("-");
      if (more !== undefined || !a || !b) throw new CronParseError(`invalid range "${rangePart}"`);
      lo = value(a);
      hi = value(b);
      if (lo > hi) throw new CronParseError(`invalid range "${rangePart}"`);
    } else {
      lo = value(rangePart!);
      hi = stepPart !== undefined ? max : lo;
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

export function parseCron(source: string): CronExpr {
  const expanded = MACROS[source.trim().toLowerCase()] ?? source.trim();
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) throw new CronParseError(`expected 5 fields, got ${fields.length}: "${source}"`);
  const [mi, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const dowSet = parseField(dow, 0, 7, DAYS);
  if (dowSet.has(7)) {
    dowSet.delete(7);
    dowSet.add(0);
  }
  return {
    source,
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTHS, 1),
    dow: dowSet,
    domStar: dom === "*" || dom.startsWith("*/"),
    dowStar: dow === "*" || dow.startsWith("*/"),
  };
}

export interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of `epochMs` in time zone `tz` (IANA name, default UTC). */
export function wallClock(epochMs: number, tz = "UTC"): WallClock {
  if (tz === "UTC") {
    const d = new Date(epochMs);
    return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), day: d.getUTCDate(), month: d.getUTCMonth() + 1, weekday: d.getUTCDay() };
  }
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAY[parts.weekday ?? ""] ?? -1,
  };
}

/** Throws RangeError for an unknown time zone. */
export function assertTimeZone(tz: string): void {
  new Intl.DateTimeFormat("en-US", { timeZone: tz });
}

export function cronMatches(expr: CronExpr, epochMs: number, tz = "UTC"): boolean {
  const w = wallClock(epochMs, tz);
  if (!expr.minute.has(w.minute) || !expr.hour.has(w.hour) || !expr.month.has(w.month)) return false;
  const domOk = expr.dom.has(w.day);
  const dowOk = expr.dow.has(w.weekday);
  if (expr.domStar && expr.dowStar) return true;
  if (expr.domStar) return dowOk;
  if (expr.dowStar) return domOk;
  return domOk || dowOk;
}

/** First matching minute strictly after `afterMs`, scanning at most `limitMinutes`. */
export function nextCronMatch(expr: CronExpr, afterMs: number, tz = "UTC", limitMinutes = 60 * 24 * 366): number | null {
  let m = Math.floor(afterMs / 60_000) + 1;
  for (let i = 0; i < limitMinutes; i++, m++) {
    if (cronMatches(expr, m * 60_000, tz)) return m * 60_000;
  }
  return null;
}

/**
 * The Worker's `scheduled()` wakes `System` only on a minute some cron matches (`cronWakeDue`), plus a catch-up call
 * every this many minutes while a cron matched inside the catch-up window (a Cron Trigger that never came is caught up then).
 */
export const CRON_HEARTBEAT_MINUTES = 10;
/** Missed minutes (e.g. a skipped Cron Trigger) are caught up to this far back by `System`, coalesced into one run. */
export const CRON_CATCH_UP_MINUTES = 60;


/**
 * Cron Triggers a Worker uses by default: one, as before. Cloudflare counts Cron Triggers per account (5 on Workers
 * Free, 250 on Paid, across every Worker), so a deploy must not spend more of them than the single trigger it always had.
 */
export const MAX_CRON_TRIGGERS = 1;

export interface CronTriggerOptions {
  /** Start of the window whose UTC offsets are looked at (time zone crons). Default `Date.now()`. */
  now?: number;
  /** How far ahead UTC offsets are collected (DST changes), in days. Default 400. */
  horizonDays?: number;
  /** Most trigger expressions returned; past it the minutes and hours are merged into one. Default `MAX_CRON_TRIGGERS`. */
  maxTriggers?: number;
  /** The `cronWakeDue` heartbeat (catch-up ticks after each match). Default `CRON_HEARTBEAT_MINUTES`. */
  heartbeatMinutes?: number;
  /** How far back `System` catches up a missed minute. Default `CRON_CATCH_UP_MINUTES`. */
  catchUpMinutes?: number;
}

export interface CronTriggerPlan {
  /** UTC Cron Trigger expressions for the Worker (empty without crons). */
  triggers: string[];
  /** Why a trigger is coarser than the crons need (e.g. a schedule that does not parse). */
  warnings: string[];
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The UTC offsets (minutes, mod 1440) `tz` takes from `now` to `days` ahead, sampled hourly. */
function utcOffsets(tz: string, now: number, days: number): Set<number> {
  const out = new Set<number>();
  if (tz === "UTC") return out.add(0);
  const start = Math.floor(now / 3_600_000) * 3_600_000;
  for (let t = start, end = start + days * 86_400_000; t <= end; t += 3_600_000) {
    const w = wallClock(t, tz);
    const d = new Date(t);
    out.add(mod(w.hour * 60 + w.minute - (d.getUTCHours() * 60 + d.getUTCMinutes()), 1440));
  }
  return out;
}

/** A cron field for `values` (sorted, inside `lo..hi`): `*`, `*\/n`, or a list of values and ranges. */
function cronField(values: number[], lo: number, hi: number): string {
  if (values.length === hi - lo + 1) return "*";
  if (values.length > 2 && values[0] === lo) {
    const step = values[1]! - values[0]!;
    if (values.every((v, i) => v === lo + i * step) && values[values.length - 1]! + step > hi) return `*/${step}`;
  }
  const parts: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${values[i]}-${values[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(values[k]));
    i = j + 1;
  }
  return parts.join(",");
}

/**
 * The sparsest UTC Cron Trigger(s) under which the Worker's `scheduled()` still sees every minute some cron matches
 * (in its time zone, across the DST offsets of the next `horizonDays`), plus every heartbeat minute of the catch-up
 * window after each of them (`cronWakeDue` wakes `System` on a heartbeat while a cron matched in the `catchUpMinutes`
 * before it, and `System` looks back as far): a Cron Trigger that never came, or an outage that took several
 * heartbeats with it, is still caught up by a later heartbeat inside the window. `System` evaluates every minute since its last
 * tick, so the tick set only has to contain the matches: an extra tick runs nothing (`cronWakeDue` skips it).
 *
 * Only minutes and hours are narrowed (day-of-month, month and weekday stay `*`: a weekly cron ticks daily, and a
 * time zone's local day is not the UTC one). Past `maxTriggers` expressions the minutes and hours of all of them are
 * merged into one. A schedule or time zone that does not parse keeps the per-minute trigger (`System` reports it).
 */
export function cronTriggers(crons: ReadonlyArray<{ schedule: string; tz?: string }>, opts: CronTriggerOptions = {}): CronTriggerPlan {
  const warnings: string[] = [];
  if (!crons.length) return { triggers: [], warnings };
  const now = opts.now ?? Date.now();
  const days = opts.horizonDays ?? 400;
  const max = Math.max(1, opts.maxTriggers ?? MAX_CRON_TRIGGERS);
  const hb = opts.heartbeatMinutes ?? CRON_HEARTBEAT_MINUTES;
  // `cronWakeDue` phases heartbeats on the epoch minute; one daily expression repeats the same minutes of the day, so
  // the two agree on every UTC day only when the heartbeat divides a day.
  if (!Number.isInteger(hb) || hb <= 0 || 1440 % hb !== 0) throw new RangeError(`cronTriggers: heartbeatMinutes must be a positive divisor of 1440 (got ${hb})`);
  const catchUp = opts.catchUpMinutes ?? CRON_CATCH_UP_MINUTES;
  const due = new Uint8Array(1440);
  const offsets = new Map<string, Set<number>>();
  let invalid = false;
  for (const c of crons) {
    const tz = c.tz ?? "UTC";
    let e: CronExpr;
    try {
      assertTimeZone(tz);
      e = parseCron(c.schedule);
    } catch (err) {
      warnings.push(`cron schedule ${JSON.stringify(c.schedule)}${c.tz ? ` (${c.tz})` : ""} is invalid (${(err as Error).message}): the Cron Trigger stays every minute`);
      invalid = true;
      continue;
    }
    if (invalid) continue;
    let os = offsets.get(tz);
    if (!os) offsets.set(tz, (os = utcOffsets(tz, now, days)));
    for (const o of os) {
      for (const h of e.hour) {
        for (const m of e.minute) {
          const u = mod(h * 60 + m - o, 1440);
          due[u] = 1;
          // Heartbeats `u + 1 .. u + catchUp - 1` (the window `cronWakeDue` and `System` look back over).
          for (let k = u + 1; k < u + catchUp; k++) if (k % hb === 0) due[mod(k, 1440)] = 1;
        }
      }
    }
  }
  if (invalid || due.every((x) => x === 1)) return { triggers: ["* * * * *"], warnings };
  // Hours with the same minutes share one expression.
  const groups = new Map<string, { minutes: number[]; hours: number[] }>();
  for (let h = 0; h < 24; h++) {
    const minutes: number[] = [];
    for (let m = 0; m < 60; m++) if (due[h * 60 + m]) minutes.push(m);
    if (!minutes.length) continue;
    const key = minutes.join(",");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { minutes, hours: [] }));
    g.hours.push(h);
  }
  const expr = (minutes: number[], hours: number[]) => `${cronField(minutes, 0, 59)} ${cronField(hours, 0, 23)} * * *`;
  if (groups.size <= max) return { triggers: [...groups.values()].map((g) => expr(g.minutes, g.hours)), warnings };
  const minutes = new Set<number>();
  const hours = new Set<number>();
  for (const g of groups.values()) {
    for (const m of g.minutes) minutes.add(m);
    for (const h of g.hours) hours.add(h);
  }
  return { triggers: [expr([...minutes].sort((a, b) => a - b), [...hours].sort((a, b) => a - b))], warnings };
}
