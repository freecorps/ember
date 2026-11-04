import { writeFileSync } from "node:fs";
import { pct, now } from "../lib/stats.mjs";
const [name, total = 200, conc = 20] = [process.argv[2], Number(process.argv[3] ?? 200), Number(process.argv[4] ?? 20)];
const U = `https://${name}.<subdomain>.workers.dev`;
const run = Date.now();
async function pool(n, c, fn) {
  const res = []; let i = 0;
  const t0 = now();
  await Promise.all(Array.from({ length: c }, async () => { while (i < n) { const k = i++; res.push(await fn(k)); } }));
  return { res, wallS: (now() - t0) / 1000 };
}
async function call(path, body) {
  const t = now();
  try {
    const r = await fetch(U + path, { method: "POST", headers: { "content-type": "application/json", origin: U }, body: JSON.stringify(body) });
    const txt = await r.text();
    return { ms: now() - t, status: r.status, err: r.ok ? null : txt.slice(0, 200) };
  } catch (e) { return { ms: now() - t, status: 0, err: String(e).slice(0, 200) }; }
}
const summarize = (label, { res, wallS }) => {
  const errs = {}; for (const r of res) if (r.status !== 200) { const k = r.status + " " + r.err; errs[k] = (errs[k] ?? 0) + 1; }
  return { label, n: res.length, ok: res.filter((r) => r.status === 200).length, perSec: Math.round(res.length / wallS * 10) / 10, latencyMs: pct(res.filter((r) => r.status === 200).map((r) => r.ms)), errors: errs };
};
// warmup
await call("/api/auth/sign-up/email", { email: `warm-${run}@ex.com`, password: "correct-horse-battery", name: "w" });
const up = await pool(total, conc, (k) => call("/api/auth/sign-up/email", { email: `u${k}-${run}@ex.com`, password: "correct-horse-battery-" + k, name: "u" + k }));
const s1 = summarize("sign-up", up); console.log(JSON.stringify(s1));
const inn = await pool(total, conc, (k) => call("/api/auth/sign-in/email", { email: `u${k}-${run}@ex.com`, password: "correct-horse-battery-" + k }));
const s2 = summarize("sign-in", inn); console.log(JSON.stringify(s2));
writeFileSync(new URL(`../evidence/r7-${name}-${total}x${conc}.json`, import.meta.url), JSON.stringify({ name, total, conc, signUp: s1, signIn: s2 }, null, 2));
