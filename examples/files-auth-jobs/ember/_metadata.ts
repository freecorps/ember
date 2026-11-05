// What the processing job learns about a file, and how (files starting with "_" in ember/ are not function modules).
import { v, type Infer } from "@freecorps/ember-server";

export const metadata = v.object({
  kind: v.string(),
  sha256: v.optional(v.string()),
  lines: v.optional(v.number()),
  words: v.optional(v.number()),
  preview: v.optional(v.string()),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
});
export type Metadata = Infer<typeof metadata>;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What the job learns about a file: line/word counts for text, the pixel size for a PNG. Throws on a corrupt file. */
export function describe(bytes: Uint8Array, contentType: string): Metadata {
  if (contentType.startsWith("text/") || contentType === "application/json") {
    const text = new TextDecoder().decode(bytes);
    const trimmed = text.trim();
    return {
      kind: "text",
      lines: trimmed ? trimmed.split(/\r?\n/).length : 0,
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      preview: trimmed.slice(0, 80),
    };
  }
  if (contentType === "image/png") {
    // 8-byte signature, then the IHDR chunk: length, "IHDR", width (4 bytes), height (4 bytes).
    if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("Not a valid PNG file");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { kind: "image", width: view.getUint32(16), height: view.getUint32(20) };
  }
  return { kind: "binary" };
}
