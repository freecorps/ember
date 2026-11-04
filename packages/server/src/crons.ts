// `crons.ts` typing (PLAN §8): `export default cronJobs()...` or a plain `CronDef[]`. Pure data: the runtime's
// System DO evaluates the schedules once a minute, in each cron's time zone, and dispatches them to their shard.

import { getFunctionName, type OptionalRestArgs, type SchedulableReference } from "./functions.ts";

export interface CronDef {
  /** Unique, stable name (used for locking and dedup). */
  name: string;
  /** 5-field cron expression or macro (`@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`). */
  schedule: string;
  /** IANA time zone, default UTC. */
  tz?: string;
  /** Target shard `<kind>:<key>`. */
  shard: string;
  /** `internal.mod.fn` (a mutation or an action) or `"mod:fn"`. */
  fn: SchedulableReference;
  args?: unknown;
  /** Defaults to the type of `fn` (resolved by the runtime). */
  kind?: "mutation" | "action";
}

export interface CronOptions {
  /** Overrides the `cronJobs({ shard })` default. */
  shard?: string;
  /** Overrides the `cronJobs({ tz })` default. */
  tz?: string;
}

type Tail<F> = [...OptionalRestArgs<F>, opts?: CronOptions | undefined];

function int(name: string, v: number | undefined, lo: number, hi: number, dflt: number): number {
  const x = v ?? dflt;
  if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`cron ${name}: expected an integer in ${lo}..${hi}, got ${x}`);
  return x;
}

/**
 * Builder for `crons.ts`, in the style of Convex:
 *
 *   const crons = cronJobs({ shard: "global:main", tz: "America/Sao_Paulo" });
 *   crons.daily("digest", { hour: 9 }, internal.email.digest);
 *   crons.cron("trim", "0 * * * *", internal.messages.trim, { keep: 1000 });
 *   export default crons;
 *
 * Unlike Convex, schedules are evaluated in `tz` (default UTC), and every cron names the shard it runs on.
 */
export class CronJobs {
  readonly jobs: CronDef[] = [];

  constructor(private readonly defaults: CronOptions = {}) {}

  /** Any 5-field cron expression or macro. */
  cron<F extends SchedulableReference>(name: string, schedule: string, fn: F, ...rest: Tail<F>): this {
    const [args, opts] = rest as unknown as [unknown, CronOptions | undefined];
    if (this.jobs.some((j) => j.name === name)) throw new Error(`cron "${name}" is defined twice`);
    const shard = opts?.shard ?? this.defaults.shard;
    if (!shard) throw new Error(`cron "${name}": no shard (pass { shard } here or to cronJobs({ shard }))`);
    const tz = opts?.tz ?? this.defaults.tz;
    // Validates the reference eagerly (a typo should fail at codegen, not at the first tick).
    getFunctionName(fn);
    this.jobs.push({ name, schedule, shard, fn, ...(args !== undefined ? { args } : {}), ...(tz ? { tz } : {}) });
    return this;
  }

  /** Every `minutes` (a divisor of 60) or `hours` (a divisor of 24), aligned to the clock. */
  interval<F extends SchedulableReference>(name: string, every: { minutes: number } | { hours: number }, fn: F, ...rest: Tail<F>): this {
    let schedule: string;
    if ("minutes" in every) {
      const m = every.minutes;
      if (!Number.isInteger(m) || m < 1 || 60 % m !== 0) throw new Error(`cron ${name}: minutes must divide 60`);
      schedule = m === 1 ? "* * * * *" : `*/${m} * * * *`;
    } else {
      const h = every.hours;
      if (!Number.isInteger(h) || h < 1 || 24 % h !== 0) throw new Error(`cron ${name}: hours must divide 24`);
      schedule = h === 1 ? "0 * * * *" : `0 */${h} * * *`;
    }
    return this.cron(name, schedule, fn, ...rest);
  }

  hourly<F extends SchedulableReference>(name: string, at: { minute?: number }, fn: F, ...rest: Tail<F>): this {
    return this.cron(name, `${int(name, at.minute, 0, 59, 0)} * * * *`, fn, ...rest);
  }

  daily<F extends SchedulableReference>(name: string, at: { hour?: number; minute?: number }, fn: F, ...rest: Tail<F>): this {
    return this.cron(name, `${int(name, at.minute, 0, 59, 0)} ${int(name, at.hour, 0, 23, 0)} * * *`, fn, ...rest);
  }

  /** `dayOfWeek`: 0 = Sunday … 6 = Saturday. */
  weekly<F extends SchedulableReference>(name: string, at: { dayOfWeek: number; hour?: number; minute?: number }, fn: F, ...rest: Tail<F>): this {
    return this.cron(name, `${int(name, at.minute, 0, 59, 0)} ${int(name, at.hour, 0, 23, 0)} * * ${int(name, at.dayOfWeek, 0, 6, 0)}`, fn, ...rest);
  }

  monthly<F extends SchedulableReference>(name: string, at: { day: number; hour?: number; minute?: number }, fn: F, ...rest: Tail<F>): this {
    return this.cron(name, `${int(name, at.minute, 0, 59, 0)} ${int(name, at.hour, 0, 23, 0)} ${int(name, at.day, 1, 31, 1)} * *`, fn, ...rest);
  }
}

export function cronJobs(defaults?: CronOptions): CronJobs {
  return new CronJobs(defaults);
}

/** A `crons.ts` default export: `cronJobs()` or `CronDef[]`. */
export type CronsExport = CronJobs | readonly CronDef[];

/** Normalizes a `crons.ts` default export to a list (accepts undefined / null as empty). */
export function cronList(x: unknown): CronDef[] {
  if (x === undefined || x === null) return [];
  if (x instanceof CronJobs) return [...x.jobs];
  if (Array.isArray(x)) return [...x];
  if (typeof x === "object" && Array.isArray((x as { jobs?: unknown }).jobs)) return [...(x as { jobs: CronDef[] }).jobs];
  throw new Error("crons.ts must `export default` cronJobs() or an array of { name, schedule, shard, fn }");
}

/** Function name of a cron's `fn` (reference or string). */
export const cronFunctionName = (c: Pick<CronDef, "fn">): string => getFunctionName(c.fn as never);
