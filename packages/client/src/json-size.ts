// `jsonSize`: the size bound of a snapshot cache that writes nothing (internal; not re-exported by index.ts).

/** A character JSON.stringify writes escaped: `"`, `\`, a control character or (when lone) a surrogate. */
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** `JSON.stringify(s).length`, without building it: walks `s` only when it holds a character written escaped. */
function stringSize(s: string): number {
  if (!NEEDS_ESCAPE.test(s)) return s.length + 2;
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) n += 2;
    else if (c < 0x20) n += 6; // \u00XX
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 2; // a surrogate pair: as is
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) n += 6; // lone: \udXXX
    else n++;
  }
  return n;
}

/**
 * The length of `stringify(x)`, without building it: what bounds an instance that writes nothing (a reader tab,
 * `memorySnapshotCache`) by `maxBytes`. Never below it (escapes are counted), so that bound holds: exact for what
 * `stringify` encodes, more for an `ArrayBuffer` (counted as its bytes). Throws on a cycle (as `stringify` would).
 */
export function jsonSize(x: unknown, depth = 0): number {
  switch (typeof x) {
    case "string":
      return stringSize(x);
    case "number":
      return Number.isFinite(x) ? (Object.is(x, -0) ? 15 : String(x).length) : 13 + String(x).length;
    case "boolean":
      return x ? 4 : 5;
    case "bigint":
      return 13 + String(x).length;
    case "object":
      break;
    default:
      return 4; // null (undefined in an array)
  }
  if (x === null) return 4;
  if (depth > 512) throw new RangeError("value too deep");
  if (x instanceof Uint8Array) return 13 + Math.ceil(x.byteLength / 3) * 4;
  if (x instanceof ArrayBuffer) return 13 + Math.ceil(x.byteLength / 3) * 4;
  if (Array.isArray(x)) {
    let n = 1 + Math.max(1, x.length);
    for (const v of x) n += jsonSize(v, depth + 1);
    return n;
  }
  let n = 2;
  let first = true;
  for (const k in x) {
    if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
    const v = (x as Record<string, unknown>)[k];
    if (v === undefined || typeof v === "function") continue;
    n += (first ? 0 : 1) + stringSize(k) + 1 + jsonSize(v, depth + 1);
    first = false;
  }
  return n;
}
