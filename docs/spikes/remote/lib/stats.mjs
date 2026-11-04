export const B = "https://ember-spike-main.<subdomain>.workers.dev";
export const WSB = "wss://ember-spike-main.<subdomain>.workers.dev";
export function pct(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const p = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  const r = (x) => Math.round(x * 10) / 10;
  return { n: a.length, min: r(a[0]), p50: r(p(0.5)), p95: r(p(0.95)), p99: r(p(0.99)), max: r(a[a.length - 1]) };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();
