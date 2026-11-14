export const fmtBytes = (n: unknown) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v < 1024 ? `${v} B` : v < 1048576 ? `${(v / 1024).toFixed(1)} KiB` : v < 1073741824 ? `${(v / 1048576).toFixed(1)} MiB` : `${(v / 1073741824).toFixed(2)} GiB`;
};

export const fmtTime = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toLocaleString() : "—");

export const ago = (ms: unknown) => {
  if (typeof ms !== "number" || !ms) return "—";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

export const fmtNum = (n: unknown, d = 0) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
};

export const fmtPct = (r: unknown) => {
  const v = Number(r);
  return Number.isFinite(v) ? `${(v * 100).toFixed(v > 0 && v < 0.001 ? 2 : 1)}%` : "—";
};

export const short = (s: unknown, n = 12) => (typeof s === "string" && s ? s.slice(0, n) : "—");

/** A cell value as text (user data: never HTML). */
export const text = (v: unknown, max = 160): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export const windows = [1, 6, 24, 72, 168] as const;
export const windowLabel = (h: number) => (h < 24 ? `${h}h` : `${h / 24}d`);
