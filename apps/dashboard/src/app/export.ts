// Client-side exports of a result (the SQL Explorer): CSV and JSON built from what the page already has, saved
// through a blob: download. Nothing is sent anywhere.

export type Cell = unknown;

/** A cell as CSV text: JSON for objects (tagged bytes, ...), "" for NULL. */
function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

/**
 * RFC 4180 CSV (CRLF, quotes doubled, fields with `,` `"` CR or LF quoted). A text cell that a spreadsheet would read as
 * a formula (`=`, `+`, `-`, `@`, tab, CR first) gets a leading `'` (CSV injection): numbers are written as they are.
 */
export function toCsv(columns: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  const field = (v: Cell): string => {
    let s = cellText(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(field), ...rows.map((r) => columns.map((_, i) => field(r[i])))].map((l) => l.join(",")).join("\r\n") + "\r\n";
}

/** Column names made unique (`SELECT a, a` → `a`, `a_2`): the keys of the JSON objects. */
export function uniqueColumns(columns: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const n = (seen.get(c) ?? 0) + 1;
    seen.set(c, n);
    let name = n === 1 ? c : `${c}_${n}`;
    while (n > 1 && columns.includes(name)) name = `${name}_`;
    return name;
  });
}

/** The rows as a JSON array of objects (one key per column, in order). */
export function toJson(columns: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  const keys = uniqueColumns(columns);
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null]))),
    null,
    2,
  );
}

/** Saves `text` as a file (a blob: URL, revoked right after the click). */
export function download(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
