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
