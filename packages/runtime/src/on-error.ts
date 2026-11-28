// `defineApp({ onError })` (contracts.md "Sentry", "Hook de erros"): the runtime tells the app's handler of every
// unhandled function error, after the caller got its failure. Off (one property read) when the app does not pass it.
//
// Called from: actions and HTTP routes (actions.ts, with the thrown value's stack), and the shard's mutations, jobs
// and one-shot queries (shard.ts, from the wire error: no stack there). Subscription re-runs are not reported (the
// same failure would be reported on every invalidation); the query that first fails is.

import { isReportableError, type FunctionErrorHandler, type FunctionErrorKind } from "@freecorps/ember-server";

export interface FailedCall {
  fn: string;
  kind: FunctionErrorKind;
  shard: string | null;
  /** The wire error the caller got (`code`, `message`, `kind: "app"` for application errors). */
  error: { code: string; message?: string; kind?: string };
  /** The thrown value, when the runtime still has it (its stack goes in the report). */
  thrown?: unknown;
}

/**
 * Calls `onError` for a failure it should hear about. Returns the handler's promise (already guarded: it never
 * rejects) for the caller to `waitUntil` or await, or undefined when there is nothing to wait for.
 */
export function reportFunctionError(onError: FunctionErrorHandler | undefined, env: Record<string, unknown>, call: FailedCall, now = Date.now()): Promise<void> | undefined {
  if (!onError || !isReportableError(call.error)) return undefined;
  const stack = call.thrown instanceof Error && typeof call.thrown.stack === "string" ? call.thrown.stack : undefined;
  const report = { fn: call.fn, kind: call.kind, shard: call.shard ?? "", code: call.error.code, message: call.error.message ?? "", ...(stack ? { stack } : {}), at: now };
  const failed = (e: unknown) => console.error(`ember: onError failed for ${call.fn}: ${e instanceof Error ? e.message : String(e)}`);
  try {
    const out = onError(report, env);
    return out && typeof (out as Promise<void>).then === "function" ? Promise.resolve(out).then(() => undefined, failed) : undefined;
  } catch (e) {
    failed(e);
    return undefined;
  }
}
