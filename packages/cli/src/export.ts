// `ember export` and `ember import ember <zip>` (PLAN §22 L4, contracts.md "Importar do Convex", formato do Ember):
// a ZIP with JSON Lines per shard and table plus the files, so a staging deployment can be refreshed from another
// deployment without Convex. Layout:
//   ember-export.json                                  { format: "ember-export", version: 1, project, createdAt, shards: [...] }
//   shards/<base64url(shard)>/<table>/documents.jsonl   one document per line (tagged JSON: bigint, bytes)
//   shards/<base64url(shard)>/_storage/documents.jsonl  `_files` rows { id, sha256, size, contentType, createdAt }
//   files/<sha256>                                     bytes, once per content
// Read through the admin endpoints `import/meta`, `import/export` and `files/content`; written back through the same
// `import/*` endpoints the Convex import uses (ids, `_creationTime` and storage ids kept).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeJson, encodeJson } from "@freecorps/ember-values";
import type { ForeignIds, ImportExportPage, ImportFileRow, ImportMeta, SchemaManifest } from "@freecorps/ember-server";
import { loadProjectCode } from "./build.ts";
import type { Project } from "./config.ts";
import { AdminClient, type ImportTarget } from "./import-convex.ts";
import { ZipReader, ZipWriter } from "./zip.ts";

export const EXPORT_FORMAT = "ember-export";
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: 1;
  project: string;
  createdAt: number;
  shards: Array<{ name: string; foreignIds: ForeignIds | null; classicTables: string[]; tables: Record<string, number>; files: number }>;
}

export async function exportEmber(o: { project: Project; target: ImportTarget; shards: string[]; out: string; log?: (l: string) => void }): Promise<ExportManifest> {
  const log = o.log ?? (() => {});
  if (!o.shards.length) throw new Error("ember export: no shard (pass --shard kind:key, repeatable, or --all)");
  const admin = new AdminClient(o.target);
  const zip = new ZipWriter(o.out);
  const manifest: ExportManifest = { format: EXPORT_FORMAT, version: 1, project: o.project.config.project, createdAt: Date.now(), shards: [] };
  const blobs = new Map<string, { shard: string; id: string }>();
  const pages = async function* (shard: string, table: string, count: (n: number) => void) {
    let after = 0;
    for (;;) {
      const p = await admin.call<ImportExportPage>("GET", `/api/_ember/import/export?${new URLSearchParams({ shard, table, after: String(after), limit: "1000" })}`);
      count(p.docs.length);
      for (const d of p.docs) yield `${encodeJson(d)}\n`;
      if (p.next === null) return;
      after = p.next;
    }
  };
  for (const shard of [...new Set(o.shards)].sort()) {
    const meta = await admin.call<ImportMeta>("GET", `/api/_ember/import/meta?shard=${encodeURIComponent(shard)}`);
    const entry: ExportManifest["shards"][number] = { name: shard, foreignIds: meta.foreignIds, classicTables: meta.classicTables, tables: {}, files: 0 };
    for (const t of meta.tables) {
      if (!t.rows) continue;
      let n = 0;
      await zip.add(`shards/${b64url(shard)}/${t.name}/documents.jsonl`, pages(shard, t.name, (k) => (n += k)));
      entry.tables[t.name] = n;
    }
    if (meta.files) {
      let n = 0;
      const rows = pages(shard, "_storage", (k) => (n += k));
      const seen: string[] = [];
      await zip.add(`shards/${b64url(shard)}/_storage/documents.jsonl`, (async function* () {
        for await (const line of rows) {
          seen.push(line);
          yield line;
        }
      })());
      for (const line of seen) {
        const r = decodeJson(line) as ImportFileRow;
        if (r.sha256 && !blobs.has(r.sha256)) blobs.set(r.sha256, { shard, id: r.id });
      }
      entry.files = n;
    }
    manifest.shards.push(entry);
    log(`${shard}: ${Object.values(entry.tables).reduce((a, b) => a + b, 0)} documents, ${entry.files} files`);
  }
  for (const [sha, { shard, id }] of blobs) {
    const bytes = await admin.bytes(`/api/_ember/files/content?${new URLSearchParams({ shard, id })}`);
    await zip.add(`files/${sha}`, bytes);
  }
  await zip.add("ember-export.json", JSON.stringify(manifest, null, 2));
  await zip.close();
  return manifest;
}

type ImportEmberState = { version: 1; zip: { path: string; size: number; mtimeMs: number }; url: string; done: Record<string, number>; finished: string[] };

export interface EmberImportReport {
  shards: Array<{ name: string; documents: number; invalid: number; files: number; skippedTables: string[] }>;
}

/** `ember import ember <zip>`: every shard of an `ember export`, resumable per (shard, table). */
export async function importEmber(o: { project: Project; target: ImportTarget; zip: string; fresh?: boolean; strict?: boolean; log?: (l: string) => void }): Promise<EmberImportReport> {
  const log = o.log ?? (() => {});
  const schema = (await loadProjectCode(o.project)).schema as { manifest?: SchemaManifest } | undefined;
  const local = schema?.manifest;
  if (!local) throw new Error("ember/schema.ts must export default defineSchema({...})");
  const zip = await ZipReader.open(o.zip);
  try {
    const m = zip.entry("ember-export.json");
    if (!m) throw new Error(`${o.zip}: not an ember export (no ember-export.json)`);
    const manifest = JSON.parse((await zip.bytes(m)).toString("utf8")) as ExportManifest;
    if (manifest.format !== EXPORT_FORMAT || manifest.version !== 1) throw new Error(`${o.zip}: unknown export format ${manifest.format} v${manifest.version}`);
    const st = statSync(o.zip);
    const dir = join(o.project.stateDir, "import");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `ember-${createHash("sha256").update(`${resolve(o.zip)}\n${st.size}\n${st.mtimeMs}\n${o.target.url}`).digest("hex").slice(0, 16)}.json`);
    if (o.fresh) rmSync(file, { force: true });
    const state: ImportEmberState = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, zip: { path: resolve(o.zip), size: st.size, mtimeMs: st.mtimeMs }, url: o.target.url, done: {}, finished: [] };
    const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
    const admin = new AdminClient(o.target);
    const report: EmberImportReport = { shards: [] };
    for (const s of manifest.shards) {
      const r = { name: s.name, documents: 0, invalid: 0, files: 0, skippedTables: [] as string[] };
      report.shards.push(r);
      if (state.finished.includes(s.name)) continue;
      const tables = Object.keys(s.tables).filter((t) => {
        if (local.tables[t] && !t.includes("$")) return true;
        r.skippedTables.push(t);
        return false;
      });
      if (r.skippedTables.length) log(`warning: ${s.name}: tables not in ember/schema.ts, not imported: ${r.skippedTables.join(", ")}`);
      await admin.call("POST", "/api/_ember/import/begin", { shard: s.name, tables, ...(s.foreignIds ? { foreignIds: s.foreignIds } : {}) });
      for (const t of tables) {
        const key = `${s.name}\u0000${t}`;
        const entry = zip.entry(`shards/${b64url(s.name)}/${t}/documents.jsonl`);
        if (!entry) continue;
        const from = state.done[key] ?? 0;
        let line = 0;
        let batch: string[] = [];
        let bytes = 0;
        const send = async () => {
          if (!batch.length) return;
          const body = `{"shard":${JSON.stringify(s.name)},"table":${JSON.stringify(t)},${o.strict ? '"strict":true,' : ""}"docs":[${batch.join(",")}]}`;
          const res = await admin.call<{ written: number; invalid: unknown[] }>("POST", "/api/_ember/import/batch", new TextEncoder().encode(body), { "content-type": "application/json" });
          r.documents += res.written;
          r.invalid += res.invalid.length;
          batch = [];
          bytes = 0;
          state.done[key] = line;
          save();
        };
        for await (const text of zip.lines(entry)) {
          line++;
          if (line <= from) continue;
          // Lines are tagged JSON already: sent as they are.
          batch.push(text);
          bytes += text.length;
          if (batch.length >= 500 || bytes >= 1_500_000) await send();
        }
        await send();
        state.done[key] = line;
        save();
      }
      const filesEntry = zip.entry(`shards/${b64url(s.name)}/_storage/documents.jsonl`);
      if (filesEntry) {
        let rows: ImportFileRow[] = [];
        for await (const text of zip.lines(filesEntry)) {
          const row = decodeJson(text) as ImportFileRow;
          const blob = zip.entry(`files/${row.sha256}`);
          if (!blob) {
            log(`warning: ${s.name}: file ${row.id} has no bytes in the export: not imported`);
            continue;
          }
          const data = await zip.bytes(blob);
          const q = new URLSearchParams({ shard: s.name, sha256: row.sha256, ...(row.contentType ? { contentType: row.contentType } : {}) });
          await admin.call("PUT", `/api/_ember/import/blob?${q}`, new Uint8Array(data), { "content-length": String(data.length) });
          rows.push(row);
          if (rows.length >= 200) {
            await admin.call("POST", "/api/_ember/import/files", { shard: s.name, rows });
            r.files += rows.length;
            rows = [];
          }
        }
        if (rows.length) await admin.call("POST", "/api/_ember/import/files", { shard: s.name, rows });
        r.files += rows.length;
      }
      await admin.call("POST", "/api/_ember/import/finish", { shard: s.name });
      state.finished.push(s.name);
      save();
      log(`${s.name}: ${r.documents} documents, ${r.files} files`);
    }
    return report;
  } finally {
    await zip.close();
  }
}
