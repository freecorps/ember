// Small time-series charts in inline SVG (no chart library: the bundle ships inside the CLI). Colors come from the
// theme tokens through CSS classes, so light and dark both work; every point has a <title> for hover and screen readers.

import type { ReactNode } from "react";
import { fmtNum } from "./format.ts";

export interface Series {
  label: string;
  /** CSS class of the mark (s1 accent, s2 info, bad, muted). */
  cls: "s1" | "s2" | "bad" | "muted";
  values: number[];
  /** Bars instead of a line. */
  bars?: boolean;
}

const W = 320;
const H = 120;
const PAD = { l: 34, r: 6, t: 8, b: 18 };

const tick = (t: number, spanMs: number) => {
  const d = new Date(t);
  return spanMs > 2 * 86_400_000 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function TimeChart({ title, times, series, unit = "", empty }: { title: string; times: number[]; series: Series[]; unit?: string; empty?: ReactNode }) {
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const n = times.length;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (max > 0 ? (v / max) * ih : 0);
  const bw = Math.max(1, Math.min(10, (iw / Math.max(1, n)) * 0.7));
  const span = n > 1 ? times[n - 1]! - times[0]! : 0;
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="legend">
          {series.map((s) => (
            <span key={s.label} className={`key ${s.cls}`}>
              {s.label}
            </span>
          ))}
        </span>
      </figcaption>
      {!n || max === 0 ? (
        <div className="chart-empty">{empty ?? "No data in this window."}</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${series.map((s) => `${s.label} up to ${fmtNum(Math.max(...s.values), 2)}${unit}`).join(", ")}`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} />
              <text className="axis" x={PAD.l - 4} y={y(max * f) + 3} textAnchor="end">
                {fmtNum(max * f, max * f < 10 ? 1 : 0)}
              </text>
            </g>
          ))}
          <text className="axis" x={PAD.l} y={H - 4}>
            {tick(times[0]!, span)}
          </text>
          <text className="axis" x={W - PAD.r} y={H - 4} textAnchor="end">
            {tick(times[n - 1]!, span)}
          </text>
          {series.map((s) =>
            s.bars ? (
              <g key={s.label} className={`bars ${s.cls}`}>
                {s.values.map((v, i) => (
                  <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0, PAD.t + ih - y(v))}>
                    <title>{`${new Date(times[i]!).toLocaleString()} · ${s.label} ${fmtNum(v, 2)}${unit}`}</title>
                  </rect>
                ))}
              </g>
            ) : (
              <g key={s.label} className={`line ${s.cls}`}>
                <polyline points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
                {s.values.map((v, i) => (
                  <circle key={i} cx={x(i)} cy={y(v)} r={n > 40 ? 1.2 : 2}>
                    <title>{`${new Date(times[i]!).toLocaleString()} · ${s.label} ${fmtNum(v, 2)}${unit}`}</title>
                  </circle>
                ))}
              </g>
            ),
          )}
        </svg>
      )}
    </figure>
  );
}
