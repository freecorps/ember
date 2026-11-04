import { env } from "cloudflare:test";

export function stubFor(name: string) {
  return env.SPIKE.get(env.SPIKE.idFromName(name));
}

/** Print a machine-greppable result line: RESULT <id> <json> */
export function report(id: string, data: unknown) {
  console.log(`RESULT ${id} ${JSON.stringify(data)}`);
}

/** Run fn, return "ok: <value>" or the error message — never throws. */
export function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
