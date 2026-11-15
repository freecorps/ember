// Per-transaction limits (PLAN §3, §22 L6): the defaults, the hard ceiling no configuration can pass, the checks for
// `defineApp({ limits })` / `query({ limits })` / `mutation({ limits })`, and the warning `ember dev` and the dashboard
// show once a function uses 70% of a limit (one wording for both: `limitWarnings`).

export type Limits = {
  /**
   * SQLite rows read per transaction (query or mutation), as the platform bills them (`cursor.rowsRead`): index
   * entries, table rows, aggregate nodes, `ctx.db.sql`. Error: `TooManyReads`.
   */
  rowsRead: number;
  /**
   * Documents read per transaction: every document `db.get`, a scan (`collect`, `take`, `first`, `paginate`, the rows a
   * `.filter()` drops included), a search or a write's own read hands to the engine (what Convex calls "documents
   * scanned"). Error: `TooManyDocumentsRead`.
   */
  documentsRead: number;
  /** SQLite rows written per mutation (index entries included). Error: `TooManyWrites`. */
  rowsWritten: number;
  /** Bytes per document (approximate encoded size). Error: `DocumentTooLarge`. */
  documentSize: number;
  /** Trigger runs per mutation (`defineTriggers`): past it the mutation fails with `TriggerLoop`. */
  triggerRuns: number;
};

/**
 * Defaults. Documents follow Convex (16 384 per transaction), so budgets calibrated there carry over; SQLite rows get
 * 4× that, because one document read through an index costs at least two rows (the index entry and the row).
 */
export const DEFAULT_LIMITS: Limits = { rowsRead: 65_536, documentsRead: 16_384, rowsWritten: 8_192, documentSize: 2 * 1024 * 1024, triggerRuns: 10_000 };

/**
 * The ceiling no `limits` (project, function or engine option) may pass: a transaction holds the shard's only thread
 * (nothing else in the Durable Object runs meanwhile) inside an isolate of 128 MB.
 * - `documentsRead` 131 072 (8× the default): decoded documents stay in memory until the result is sent; at ~1 KB each
 *   that is the isolate's memory.
 * - `rowsRead` 524 288: about half a second of SQLite at ~1 µs per row, the 1 s of CPU per transaction of PLAN §3.
 * - `rowsWritten` 65 536: one commit (every write of the batch waits on it) and its billing.
 * - `documentSize` 2 MiB: the engine's own limit (SQLite takes ~8 MiB per value, R5); larger values go to the files
 *   store. It can only be lowered.
 * - `triggerRuns` 80 000 (8×): each run is user code inside the transaction (its writes are bounded by rowsWritten).
 */
export const MAX_LIMITS: Limits = { rowsRead: 524_288, documentsRead: 131_072, rowsWritten: 65_536, documentSize: 2 * 1024 * 1024, triggerRuns: 80_000 };

/** The counters a call uses up (`documentSize` is per document, not per call). */
export type LimitCounter = "rowsRead" | "documentsRead" | "rowsWritten";
export const LIMIT_COUNTERS: readonly LimitCounter[] = ["rowsRead", "documentsRead", "rowsWritten"];

/** What one top-level call used, against the limits it ran with (nested `ctx.runQuery`/`runMutation` included). */
export type Usage = { rowsRead: number; documentsRead: number; rowsWritten: number; limits: Limits };

/** Fraction of each limit a call used (0 when the limit does not apply). */
export function usageFractions(u: Usage): Record<LimitCounter, number> {
  const f = (k: LimitCounter) => (u.limits[k] > 0 ? u[k] / u.limits[k] : 0);
  return { rowsRead: f("rowsRead"), documentsRead: f("documentsRead"), rowsWritten: f("rowsWritten") };
}

/** From this fraction of a limit on, `ember dev` and the dashboard warn. */
export const LIMIT_WARN_AT = 0.7;

const COUNTER_TEXT: Record<LimitCounter, { what: string; error: string; fix: string }> = {
  rowsRead: { what: "SQLite rows read", error: "TooManyReads", fix: "narrow the scan with an index or paginate" },
  documentsRead: { what: "documents read", error: "TooManyDocumentsRead", fix: "paginate, or narrow the scan with an index instead of .filter()" },
  rowsWritten: { what: "rows written", error: "TooManyWrites", fix: "split the work into scheduled batches" },
};

/**
 * The warning for each counter at or above 70% of its limit (`fractions` from `usageFractions`, or the peaks the
 * dashboard reads from Analytics Engine). The same text in `ember dev` and the dashboard.
 */
export function limitWarnings(fractions: Partial<Record<LimitCounter, number>>): Array<{ kind: "limits"; counter: LimitCounter; message: string }> {
  const out: Array<{ kind: "limits"; counter: LimitCounter; message: string }> = [];
  for (const k of LIMIT_COUNTERS) {
    const x = fractions[k] ?? 0;
    if (!(x >= LIMIT_WARN_AT)) continue;
    const t = COUNTER_TEXT[k];
    out.push({
      kind: "limits",
      counter: k,
      message: `used ${Math.round(x * 100)}% of its ${t.what} limit (${t.error} at 100%): ${t.fix}, or raise limits.${k} in its definition or in defineApp({ limits })`,
    });
  }
  return out;
}

const KEYS: readonly (keyof Limits)[] = ["rowsRead", "documentsRead", "rowsWritten", "documentSize", "triggerRuns"];

/**
 * Checks a `limits` object (`where`: who declared it, for the message): known keys only (`allowed`), positive integers,
 * at most `MAX_LIMITS`. Returns a frozen copy without undefined entries. Throws an Error (a definition mistake).
 */
export function checkLimits(limits: unknown, where: string, allowed: readonly (keyof Limits)[] = KEYS): Readonly<Partial<Limits>> {
  if (limits === undefined) return Object.freeze({});
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) throw new Error(`${where}: limits must be an object`);
  const out: Partial<Limits> = {};
  for (const [k, x] of Object.entries(limits)) {
    if (x === undefined) continue;
    if (!(KEYS as readonly string[]).includes(k)) throw new Error(`${where}: unknown limit ${JSON.stringify(k)} (known: ${KEYS.join(", ")})`);
    if (!(allowed as readonly string[]).includes(k)) throw new Error(`${where}: limits.${k} does not apply here (allowed: ${allowed.join(", ")})`);
    const key = k as keyof Limits;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 1) throw new Error(`${where}: limits.${k} must be a positive integer`);
    if (x > MAX_LIMITS[key]) throw new Error(`${where}: limits.${k} is ${x}, above the ceiling of ${MAX_LIMITS[key]} (MAX_LIMITS: a transaction holds the shard's only thread)`);
    out[key] = x;
  }
  return Object.freeze(out);
}

/** Limits a query may set (it writes nothing). */
export const QUERY_LIMIT_KEYS: readonly (keyof Limits)[] = ["rowsRead", "documentsRead"];
