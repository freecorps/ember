// `ember import convex <snapshot.zip>` and `ember import verify convex <snapshot.zip>` (PLAN §22 L4, contracts.md
// "Importar do Convex"). The snapshot ZIP is streamed (never loaded whole): one JSON Lines entry per table
// (`<table>/documents.jsonl`), `_tables/documents.jsonl` (table numbers), `_storage/documents.jsonl` plus one entry
// per stored file (`_storage/<id>`). Every document goes through the same pipeline on every run: Convex JSON →
// Ember values (by the table's schema), `transform`, routing (`route`, or the parent's shard for `via` tables). The
// import uploads the routed documents in batches to the shards (admin endpoints `import/*`), checkpointing a line
// per table in a local state file; a later run resumes from it (routes of the lines already sent are recomputed by
// reading them again, without uploading). Verify recomputes the same documents and compares counts and an
// order-independent hash per table and shard with what each shard holds.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { base64ToBytes, decodeJson, encodeJson, validate, type ObjectShape, type Shape } from "@freecorps/ember-values";
import {
  checkImportDoc,
  collectFiles,
  convexTableNumber,
  DEFAULT_LIMITS,
  DocSetHash,
  isImportConfig,
  parseId,
  storageDigestDoc,
  type ForeignIds,
  type ImportConfig,
  type ImportDoc,
  type SchemaManifest,
} from "@freecorps/ember-server";
import { loadProjectCode } from "./build.ts";
import type { Project } from "./config.ts";
import { ZipReader, type ZipEntry } from "./zip.ts";

export const SHARD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}:[^\s]{1,190}$/;
const TABLE_RE = /^([A-Za-z][A-Za-z0-9_]*)\/documents\.jsonl$/;

export interface ImportTarget {
  url: string;
  adminToken: string;
  fetch?: typeof fetch;
}

export interface ConvexImportOptions {
  project: Project;
  zip: string;
  /** The deployment (or `ember dev`); not needed with `dryRun`. */
  target?: ImportTarget;
  dryRun?: boolean;
  /** One invalid document fails its batch, and the import stops. */
  strict?: boolean;
  /** Only these tables are uploaded (others are still read when a `via` child needs their routes). */
  only?: string[];
  /** Ignore the state file of an earlier run and start over. */
  fresh?: boolean;
  log?: (line: string) => void;
  /** Documents / encoded bytes per batch (defaults 500 / 1.5 MB). */
  batchDocs?: number;
  batchBytes?: number;
  /** Lines between checkpoints (default 5000). */
  checkpointEvery?: number;
  /** Tests: stop (as a crash would) after this many uploaded batches. */
  stopAfterBatches?: number;
}

export type TableReport = {
  read: number;
  imported: number;
  invalid: number;
  /** `route` returned null (or `transform` did). */
  skipped: number;
  /** `via` child whose parent was skipped or missing. */
  orphans: number;
  shards: Record<string, number>;
};

export interface ConvexImportReport {
  dryRun: boolean;
  tables: Record<string, TableReport>;
  files: { entries: number; imported: number; skipped: number; missingBytes: number; shaMismatch: number; uploads: number };
  /** Schema check and snapshot notes (printed before the upload starts). */
  warnings: string[];
  /** First invalid documents (all of them in `invalidFile`). */
  invalid: Array<{ table: string; id: string | null; shard: string | null; message: string }>;
  shards: string[];
  foreignIds: ForeignIds;
  stateFile: string | null;
  invalidFile: string | null;
  /** The run stopped before the end (`stopAfterBatches`): run again to resume. */
  interrupted?: true;
}

// ------------------------------------------------------------------------------------------------ Convex values

/**
 * A value of Convex's JSON export as the Ember value `shape` wants: Int64 comes as a base-10 string, Bytes as base64,
 * non-finite floats as strings. Values that do not fit are returned as they are (validation reports them).
 */
export function fromConvexJson(shape: Shape | undefined, x: unknown): unknown {
  if (!shape || x === null || x === undefined) return x;
  switch (shape.kind) {
    case "int64":
      if (typeof x === "string" && /^-?[0-9]+$/.test(x)) return BigInt(x);
      if (typeof x === "number" && Number.isSafeInteger(x)) return BigInt(x);
      return x;
    case "number":
      if (x === "NaN") return Number.NaN;
      if (x === "Infinity" || x === "inf") return Number.POSITIVE_INFINITY;
      if (x === "-Infinity" || x === "-inf") return Number.NEGATIVE_INFINITY;
      return x;
    case "bytes":
      if (typeof x === "string") {
        try {
          return base64ToBytes(x);
        } catch {
          return x;
        }
      }
      return x;
    case "literal": {
      const lit = (shape as { value?: unknown }).value;
      return typeof lit === "object" && lit && "$int64" in lit && typeof x === "string" && /^-?[0-9]+$/.test(x) ? BigInt(x) : x;
    }
    case "object": {
      if (typeof x !== "object" || Array.isArray(x)) return x;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = fromConvexJson(shape.fields[k]?.shape, v);
      return out;
    }
    case "record": {
      if (typeof x !== "object" || Array.isArray(x)) return x;
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, fromConvexJson(shape.value, v)]));
    }
    case "array":
      return Array.isArray(x) ? x.map((v) => fromConvexJson(shape.item, v)) : x;
    case "union": {
      // The first member the converted value validates against.
      for (const m of shape.members) {
        const y = fromConvexJson(m, x);
        if (validate(m, y).ok) return y;
      }
      return x;
    }
    default:
      return x;
  }
}

/** A storage entry's SHA-256 as lowercase hex (the export has hex or base64), or null. */
export function normalizeSha256(x: unknown): string | null {
  if (typeof x !== "string") return null;
  if (/^[0-9a-fA-F]{64}$/.test(x)) return x.toLowerCase();
  try {
    const b = base64ToBytes(x.replace(/-/g, "+").replace(/_/g, "/"));
    return b.length === 32 ? Buffer.from(b).toString("hex") : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ snapshot

export interface ConvexSnapshot {
  zip: ZipReader;
  /** Table → its `documents.jsonl`. */
  tables: Map<string, ZipEntry>;
  /** Table → table number (from `_tables`, else from the first document's id). */
  numbers: Map<string, number>;
  storage: ZipEntry | undefined;
  /** Storage id → its bytes' entry. */
  blobs: Map<string, ZipEntry>;
  /** Table → first line of its `generated_schema.jsonl` (Convex's inferred shape), when present. */
  inferred: Map<string, string>;
  notes: string[];
}

export async function openConvexSnapshot(path: string): Promise<ConvexSnapshot> {
  const zip = await ZipReader.open(path);
  const tables = new Map<string, ZipEntry>();
  const blobs = new Map<string, ZipEntry>();
  const inferred = new Map<string, string>();
  const notes: string[] = [];
  const ignored = new Set<string>();
  let storage: ZipEntry | undefined;
  let tablesEntry: ZipEntry | undefined;
  for (const e of zip.entries) {
    if (e.name.endsWith("/")) continue;
    const m = TABLE_RE.exec(e.name);
    if (m) tables.set(m[1]!, e);
    else if (e.name === "_tables/documents.jsonl") tablesEntry = e;
    else if (e.name === "_storage/documents.jsonl") storage = e;
    else if (e.name.startsWith("_storage/")) blobs.set(e.name.slice("_storage/".length).split(".")[0]!, e);
    else if (/^[A-Za-z][A-Za-z0-9_]*\/generated_schema\.jsonl$/.test(e.name)) {
      for await (const line of zip.lines(e)) {
        inferred.set(e.name.split("/")[0]!, line);
        break;
      }
    } else ignored.add(e.name.split("/")[0]!);
  }
  if (ignored.has("_components")) notes.push("components (`_components/`) are not imported: install the matching Ember components and move their data with their own tools");
  for (const d of [...ignored].filter((x) => x !== "_components").sort()) notes.push(`${d}/ is not imported`);
  const numbers = new Map<string, number>();
  if (tablesEntry) {
    for await (const line of zip.lines(tablesEntry)) {
      const r = JSON.parse(line) as Record<string, unknown>;
      const name = r.name ?? r.tableName;
      const n = r.id ?? r.number ?? r.tableNumber;
      if (typeof name === "string" && typeof n === "number") numbers.set(name, n);
    }
  }
  // The first id of each table says its number too: fills a missing `_tables` and cross-checks it.
  for (const [name, e] of tables) {
    for await (const line of zip.lines(e)) {
      const n = convexTableNumber((JSON.parse(line) as { _id?: unknown })._id);
      if (n !== undefined) {
        if (numbers.has(name) && numbers.get(name) !== n) notes.push(`${name}: _tables says table number ${numbers.get(name)}, its ids say ${n} (using the ids)`);
        numbers.set(name, n);
      }
      break;
    }
  }
  if (storage && !blobs.size) notes.push("_storage/documents.jsonl has no file bytes next to it (a backup without file storage?): files are not imported");
  return { zip, tables, numbers, storage, blobs, inferred, notes };
}

// ------------------------------------------------------------------------------------------------ routing

export type Routed = { doc: ImportDoc; shard: string | null; why?: "skipped" | "orphan" };

/** Where routes are kept: in memory for a ZIP run (parents only), on disk for the delta mode (every document). */
export interface RouteStore {
  get(id: string): string | null | undefined;
  set(table: string, id: string, shard: string | null): void;
}

export interface Pipeline {
  order: string[];
  /** Tables whose routes `via` children need. */
  parents: Set<string>;
  parentShard: Map<string, Map<string, string | null>>;
  route(table: string, raw: Record<string, unknown>): Routed;
}

export function documentShape(m: SchemaManifest, table: string): ObjectShape {
  return m.tables[table]!.document;
}

function idTableOf(shape: Shape | undefined): string | undefined {
  if (!shape) return undefined;
  if (shape.kind === "id") return shape.table;
  if (shape.kind === "union") for (const x of shape.members) if (x.kind === "id") return x.table;
  return undefined;
}

export function makePipeline(m: SchemaManifest, config: ImportConfig, tables: string[], store?: RouteStore): Pipeline {
  const via = new Map<string, { field: string; parent: string }>();
  for (const [child, field] of Object.entries(config.via ?? {})) {
    if (typeof field !== "string") continue;
    if (!m.tables[child]) throw new Error(`import.config via: ${child} is not a table of the schema`);
    const parent = idTableOf(m.tables[child]!.document.fields[field]?.shape);
    if (!parent) throw new Error(`import.config via: ${child}.${field} must be a v.id(...) field (its table is the parent)`);
    via.set(child, { field, parent });
  }
  // Parents before their children (a cycle cannot be routed).
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: string, path: string[]) => {
    if (state.get(t) === "done") return;
    if (state.get(t) === "visiting") throw new Error(`import.config via has a cycle: ${[...path, t].join(" → ")}`);
    state.set(t, "visiting");
    const v = via.get(t);
    if (v && tables.includes(v.parent)) visit(v.parent, [...path, t]);
    state.set(t, "done");
    order.push(t);
  };
  for (const t of [...tables].sort()) visit(t, []);
  const parents = new Set([...via.values()].map((v) => v.parent));
  const parentShard = new Map<string, Map<string, string | null>>([...parents].map((p) => [p, new Map()]));
  return {
    order,
    parents,
    parentShard,
    route(table, raw) {
      const shape = documentShape(m, table);
      const converted = fromConvexJson(shape, raw) as ImportDoc;
      const doc = config.transform ? config.transform(table, converted) : converted;
      let shard: string | null;
      let why: Routed["why"];
      if (!doc) {
        shard = null;
        why = "skipped";
      } else {
        const v = via.get(table);
        if (v) {
          const ref = doc[v.field];
          shard = typeof ref === "string" ? ((store ? store.get(ref) : parentShard.get(v.parent)?.get(ref)) ?? null) : null;
          if (!shard) why = "orphan";
        } else {
          shard = config.route(table, doc) ?? null;
          if (!shard) why = "skipped";
        }
        if (shard !== null && !SHARD_RE.test(shard)) throw new Error(`import.config route: ${table} ${doc._id} → ${JSON.stringify(shard)} is not a shard name (kind:key)`);
      }
      const out = doc ?? converted;
      if (store) store.set(table, String(out._id), shard);
      else if (parents.has(table)) parentShard.get(table)!.set(String(out._id), shard);
      return { doc: out, shard, ...(why ? { why } : {}) };
    },
  };
}

export async function loadImport(project: Project): Promise<{ manifest: SchemaManifest; config: ImportConfig; documentSize: number }> {
  const loaded = await loadProjectCode(project);
  const manifest = (loaded.schema as { manifest?: SchemaManifest } | undefined)?.manifest;
  if (!manifest) throw new Error("ember/schema.ts must export default defineSchema({...})");
  if (!loaded.importConfig) throw new Error("ember import needs ember/import.config.ts: export default defineImport({ route(table, doc) { ... } })");
  if (!isImportConfig(loaded.importConfig)) throw new Error("ember/import.config.ts must `export default defineImport({...})` (from @freecorps/ember-server)");
  // The shard's document limit (`defineApp({ limits })`, else the default): the same check runs here and there.
  const limits = (loaded.app as { limits?: { documentSize?: unknown } } | undefined)?.limits;
  const documentSize = typeof limits?.documentSize === "number" ? limits.documentSize : DEFAULT_LIMITS.documentSize;
  return { manifest, config: loaded.importConfig, documentSize };
}

/** Snapshot tables that are imported, and the schema check against the Ember schema. */
function plan(snap: ConvexSnapshot, m: SchemaManifest, config: ImportConfig): { tables: string[]; foreignIds: ForeignIds; warnings: string[] } {
  const skip = new Set(config.skip ?? []);
  const warnings = [...snap.notes];
  const tables: string[] = [];
  for (const t of [...snap.tables.keys()].sort()) {
    if (skip.has(t)) continue;
    if (!m.tables[t] || t.includes("$")) warnings.push(`table ${t} of the snapshot is not in ember/schema.ts: not imported (add it, or list it in skip)`);
    else tables.push(t);
  }
  for (const t of Object.keys(m.tables).sort()) if (!t.includes("$") && !snap.tables.has(t) && !skip.has(t)) warnings.push(`table ${t} of ember/schema.ts is not in the snapshot`);
  const convex: Record<string, string> = {};
  for (const [t, n] of snap.numbers) if (m.tables[t] && !t.includes("$")) convex[String(n)] = t;
  return { tables, foreignIds: { convex }, warnings };
}

/** Field-level schema check on the first `n` documents of each table (before anything is uploaded). */
async function sampleCheck(snap: ConvexSnapshot, m: SchemaManifest, tables: string[], tableOfId: (id: string) => string | undefined, n = 500): Promise<string[]> {
  const out: string[] = [];
  for (const t of tables) {
    const shape = documentShape(m, t);
    const unknown = new Map<string, number>();
    const invalid = new Map<string, number>();
    let i = 0;
    for await (const line of snap.zip.lines(snap.tables.get(t)!)) {
      if (i++ >= n) break;
      const raw = JSON.parse(line) as Record<string, unknown>;
      const { _id: _i, _creationTime: _c, ...rest } = raw;
      for (const k of Object.keys(rest)) if (!shape.fields[k]) unknown.set(k, (unknown.get(k) ?? 0) + 1);
      const r = validate(shape, fromConvexJson(shape, rest), { tableOfId });
      if (!r.ok) invalid.set(r.path, (invalid.get(r.path) ?? 0) + 1);
    }
    const inferred = snap.inferred.get(t);
    for (const [k, c] of unknown) out.push(`${t}.${k}: field in ${c} of the first ${Math.min(i, n)} documents, not in ember/schema.ts${inferred ? ` (Convex inferred: ${inferred.slice(0, 200)})` : ""}`);
    for (const [p, c] of invalid) out.push(`${t}: ${c} of the first ${Math.min(i, n)} documents fail the Ember schema at ${p || "(document)"}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ admin client

export class AdminClient {
  private readonly t: ImportTarget;
  constructor(t: ImportTarget) {
    this.t = t;
  }

  async call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.t.url);
    let last: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      let res: Response;
      try {
        res = await (this.t.fetch ?? fetch)(url, {
          method,
          headers: { authorization: `Bearer ${this.t.adminToken}`, ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
          ...(body === undefined ? {} : { body: body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : encodeJson(body) }),
        });
      } catch (e) {
        last = e as Error;
        continue;
      }
      const text = await res.text();
      let json: { ok?: boolean; value?: T; error?: { code: string; message: string } } = {};
      try {
        json = decodeJson(text) as typeof json;
      } catch {
        // not JSON
      }
      if (res.ok && json.ok) return json.value as T;
      const err = Object.assign(new Error(`${method} ${url.pathname}: ${res.status} ${json.error?.code ?? ""} ${json.error?.message ?? text.slice(0, 300)}`.trim()), { status: res.status, code: json.error?.code });
      if (res.status < 500) throw err;
      last = err;
    }
    throw last!;
  }

  /** A GET whose body is bytes (`files/content`). */
  async bytes(path: string): Promise<Uint8Array> {
    const res = await (this.t.fetch ?? fetch)(new URL(path, this.t.url), { headers: { authorization: `Bearer ${this.t.adminToken}` } });
    if (!res.ok) throw Object.assign(new Error(`GET ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }
}

// ------------------------------------------------------------------------------------------------ state

type ImportState = {
  version: 1;
  zip: { path: string; size: number; mtimeMs: number };
  url: string;
  tables: Record<string, { line: number; done: boolean; imported: number; invalid: number }>;
  files: { line: number; done: boolean; imported: number };
  /** Shards that got `import/begin` (the foreign-id map). */
  begun: string[];
  /** `${shard} ${table}` pairs begun (pinned classic): only tables that get documents in that shard. */
  prepared?: string[];
  finished: string[];
};

function stateFiles(project: Project, zip: string, url: string) {
  const st = statSync(zip);
  const key = createHash("sha256").update(`${resolve(zip)}\n${st.size}\n${st.mtimeMs}\n${url}`).digest("hex").slice(0, 16);
  const dir = join(project.stateDir, "import");
  return { dir, state: join(dir, `convex-${key}.json`), invalid: join(dir, `convex-${key}.invalid.jsonl`), zip: { path: resolve(zip), size: st.size, mtimeMs: st.mtimeMs } };
}

// ------------------------------------------------------------------------------------------------ import

const emptyTable = (): TableReport => ({ read: 0, imported: 0, invalid: 0, skipped: 0, orphans: 0, shards: {} });

export async function importConvex(o: ConvexImportOptions): Promise<ConvexImportReport> {
  const log = o.log ?? (() => {});
  if (!o.dryRun && !o.target) throw new Error("ember import convex: no target (pass --env or --url, or --dry-run)");
  const { manifest, config, documentSize } = await loadImport(o.project);
  const snap = await openConvexSnapshot(o.zip);
  try {
    const p = plan(snap, manifest, config);
    const prefixes = new Map(Object.entries(manifest.tables).map(([n, t]) => [t.idPrefix, n]));
    const tableOfId = (id: string) => {
      const e = parseId(id);
      if (e) return prefixes.get(e.prefix);
      const n = convexTableNumber(id);
      return n === undefined ? undefined : p.foreignIds.convex?.[String(n)];
    };
    const warnings = [...p.warnings, ...(await sampleCheck(snap, manifest, p.tables, tableOfId))];
    for (const w of warnings) log(`warning: ${w}`);
    const only = o.only?.length ? new Set(o.only) : null;
    for (const t of only ?? []) if (!p.tables.includes(t)) throw new Error(`--only ${t}: not a table this snapshot imports (${p.tables.join(", ") || "none"})`);
    const pipe = makePipeline(manifest, config, p.tables);
    const report: ConvexImportReport = {
      dryRun: !!o.dryRun,
      tables: Object.fromEntries(p.tables.map((t) => [t, emptyTable()])),
      files: { entries: 0, imported: 0, skipped: 0, missingBytes: 0, shaMismatch: 0, uploads: 0 },
      warnings,
      invalid: [],
      shards: [],
      foreignIds: p.foreignIds,
      stateFile: null,
      invalidFile: null,
    };
    const admin = o.target ? new AdminClient(o.target) : null;
    const files = o.target ? stateFiles(o.project, o.zip, o.target.url) : null;
    let state: ImportState | null = null;
    if (files && !o.dryRun) {
      mkdirSync(files.dir, { recursive: true });
      if (o.fresh) {
        rmSync(files.state, { force: true });
        rmSync(files.invalid, { force: true });
      }
      state = existsSync(files.state) ? (JSON.parse(readFileSync(files.state, "utf8")) as ImportState) : null;
      if (state) log(`resuming the import recorded in ${files.state} (--fresh starts over)`);
      state ??= { version: 1, zip: files.zip, url: o.target!.url, tables: {}, files: { line: 0, done: false, imported: 0 }, begun: [], prepared: [], finished: [] };
      report.stateFile = files.state;
      report.invalidFile = files.invalid;
    }
    const save = () => state && files && writeFileSync(files.state, JSON.stringify(state, null, 2));
    const shards = new Set<string>(state?.begun ?? []);
    const begun = new Set<string>(state?.begun ?? []);
    const prepared = new Set<string>(state?.prepared ?? []);
    const refs = new Map<string, Set<string>>();
    const upload = new Set(p.tables.filter((t) => !only || only.has(t)));
    let batches = 0;
    const stop = () => o.stopAfterBatches !== undefined && batches >= o.stopAfterBatches;

    // Before every write to a shard: the foreign-id map once per shard, and only the tables that get documents there
    // are pinned classic (a rebuild each, for good). A shard finished by an earlier run (`--only`) is finished again.
    const begin = async (shard: string, table?: string) => {
      if (state?.finished.includes(shard)) {
        state.finished = state.finished.filter((s) => s !== shard);
        save();
      }
      const k = table === undefined ? null : `${shard} ${table}`;
      if (begun.has(shard) && (k === null || prepared.has(k))) return;
      await admin!.call("POST", "/api/_ember/import/begin", { shard, foreignIds: p.foreignIds, tables: table === undefined ? [] : [table] });
      begun.add(shard);
      if (k !== null) prepared.add(k);
      if (state) {
        state.begun = [...begun].sort();
        state.prepared = [...prepared].sort();
      }
      save();
    };
    const recordInvalid = (table: string, shard: string | null, id: string | null, message: string) => {
      if (report.invalid.length < 100) report.invalid.push({ table, id, shard, message });
      if (files && !o.dryRun) appendFileSync(files.invalid, `${JSON.stringify({ table, shard, id, message })}\n`);
    };

    for (const table of pipe.order) {
      const tr = report.tables[table]!;
      const ts = state ? (state.tables[table] ??= { line: 0, done: false, imported: 0, invalid: 0 }) : null;
      const shape = documentShape(manifest, table);
      const sending = upload.has(table) && !o.dryRun;
      // Lines up to the last checkpoint were sent by an earlier run: read again (routes, file references), not sent.
      const resumeAt = ts?.line ?? 0;
      tr.imported = ts?.imported ?? 0;
      tr.invalid = ts?.invalid ?? 0;
      if (ts?.done && !pipe.parents.has(table) && !shapeHasFileFields(shape)) {
        log(`${table}: already imported (${ts.imported} documents)`);
        continue;
      }
      const buffers = new Map<string, { docs: string[]; bytes: number }>();
      const flush = async (shard: string) => {
        const b = buffers.get(shard);
        if (!b || !b.docs.length) return;
        buffers.delete(shard);
        await begin(shard, table);
        // The documents are wire JSON already: spliced into the body, not re-encoded.
        const body = `{"shard":${JSON.stringify(shard)},"table":${JSON.stringify(table)},${o.strict ? '"strict":true,' : ""}"docs":[${b.docs.join(",")}]}`;
        const res = await admin!.call<{ written: number; invalid: Array<{ index: number; id: string | null; message: string }> }>("POST", "/api/_ember/import/batch", new TextEncoder().encode(body), { "content-type": "application/json" });
        tr.imported += res.written;
        tr.invalid += res.invalid.length;
        for (const x of res.invalid) recordInvalid(table, shard, x.id, x.message);
        batches++;
      };
      const flushAll = async () => {
        for (const s of [...buffers.keys()]) await flush(s);
      };
      const checkpoint = (line: number, done: boolean) => {
        if (!ts) return;
        Object.assign(ts, { line, done, imported: tr.imported, invalid: tr.invalid });
        save();
      };
      let line = 0;
      let interrupted = false;
      for await (const text of snap.zip.lines(snap.tables.get(table)!)) {
        line++;
        const r = pipe.route(table, JSON.parse(text) as Record<string, unknown>);
        tr.read++;
        if (!r.shard) {
          if (r.why === "orphan") tr.orphans++;
          else tr.skipped++;
          continue;
        }
        tr.shards[r.shard] = (tr.shards[r.shard] ?? 0) + 1;
        shards.add(r.shard);
        for (const id of collectFiles(shape, r.doc)) {
          let s = refs.get(id);
          if (!s) refs.set(id, (s = new Set()));
          s.add(r.shard);
        }
        if (o.dryRun) {
          // The shard's own check (`checkImportDoc`): what it would refuse is reported as invalid here.
          const c = checkImportDoc(table, shape, r.doc, { tableOfId, documentSize });
          if (typeof c === "string") {
            tr.invalid++;
            recordInvalid(table, r.shard, typeof r.doc._id === "string" ? r.doc._id : null, c);
          } else tr.imported++;
          continue;
        }
        if (!sending || line <= resumeAt) continue;
        let b = buffers.get(r.shard);
        if (!b) buffers.set(r.shard, (b = { docs: [], bytes: 0 }));
        const enc = encodeJson(r.doc);
        b.docs.push(enc);
        b.bytes += enc.length;
        if (b.docs.length >= (o.batchDocs ?? 500) || b.bytes >= (o.batchBytes ?? 1_500_000)) await flush(r.shard);
        if (stop()) {
          interrupted = true;
          break;
        }
        if (line % (o.checkpointEvery ?? 5000) === 0) {
          await flushAll();
          checkpoint(line, false);
          log(`${table}: ${line} lines read, ${tr.imported} documents imported`);
          if (stop()) {
            interrupted = true;
            break;
          }
        }
      }
      if (interrupted) {
        // As a crash would leave it: the state file points at the last checkpoint.
        report.interrupted = true;
        report.shards = [...shards].sort();
        return report;
      }
      // Only a table whose documents were sent is done: one only read (`--only`, a dry run) stays where it was.
      if (sending) {
        await flushAll();
        checkpoint(line, true);
      }
      log(`${table}: ${tr.read} read, ${tr.imported} ${o.dryRun ? "valid" : "imported"}, ${tr.invalid} invalid, ${tr.skipped} skipped${tr.orphans ? `, ${tr.orphans} without a parent` : ""}, ${Object.keys(tr.shards).length} shard(s)`);
    }

    await importFiles(o, snap, config, refs, report, shards, state, save, admin, begin, log);
    report.shards = [...shards].sort();
    if (!o.dryRun && admin && state) {
      for (const shard of [...begun].sort()) {
        if (state.finished.includes(shard)) continue;
        await admin.call("POST", "/api/_ember/import/finish", { shard });
        state.finished.push(shard);
        save();
      }
    }
    return report;
  } finally {
    await snap.zip.close();
  }
}

function shapeHasFileFields(shape: Shape): boolean {
  return collectFilesShapes(shape);
}

function collectFilesShapes(shape: Shape): boolean {
  switch (shape.kind) {
    case "file":
      return true;
    case "object":
      return Object.values(shape.fields).some((f) => collectFilesShapes(f.shape));
    case "array":
      return collectFilesShapes(shape.item);
    case "record":
      return collectFilesShapes(shape.value);
    case "union":
      return shape.members.some(collectFilesShapes);
    default:
      return false;
  }
}

/** Where each storage entry goes: the shards whose documents reference it, else `route("_storage", doc)`. */
function storageTargets(config: ImportConfig, refs: Map<string, Set<string>>, doc: ImportDoc): string[] {
  const r = refs.get(doc._id);
  if (r?.size) return [...r].sort();
  const s = config.route("_storage", doc);
  if (s && !SHARD_RE.test(s)) throw new Error(`import.config route: _storage ${doc._id} → ${JSON.stringify(s)} is not a shard name (kind:key)`);
  return s ? [s] : [];
}

async function importFiles(
  o: ConvexImportOptions,
  snap: ConvexSnapshot,
  config: ImportConfig,
  refs: Map<string, Set<string>>,
  report: ConvexImportReport,
  shards: Set<string>,
  state: ImportState | null,
  save: () => void,
  admin: AdminClient | null,
  begin: (shard: string) => Promise<void>,
  log: (l: string) => void,
): Promise<void> {
  if (!snap.storage || (o.only?.length && !o.only.includes("_storage"))) return;
  const f = report.files;
  if (state?.files.done) {
    f.imported = state.files.imported;
    log(`_storage: already imported (${f.imported} files)`);
    return;
  }
  const rows = new Map<string, Array<{ id: string; sha256: string; size: number; contentType: string | null; createdAt: number }>>();
  const flush = async (shard: string) => {
    const list = rows.get(shard);
    if (!list?.length || !admin) return;
    rows.delete(shard);
    await begin(shard);
    await admin.call("POST", "/api/_ember/import/files", { shard, rows: list });
  };
  let line = 0;
  let bucketless = false;
  for await (const text of snap.zip.lines(snap.storage)) {
    line++;
    const doc = JSON.parse(text) as ImportDoc & { sha256?: unknown; size?: unknown; contentType?: unknown };
    f.entries++;
    const targets = storageTargets(config, refs, doc);
    if (!targets.length) {
      f.skipped++;
      continue;
    }
    const blob = snap.blobs.get(doc._id);
    if (!blob) {
      f.missingBytes++;
      continue;
    }
    for (const t of targets) shards.add(t);
    if (o.dryRun || !admin || bucketless) {
      f.imported++;
      continue;
    }
    if (state && line <= state.files.line) {
      f.imported++;
      continue;
    }
    const bytes = await snap.zip.bytes(blob);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const given = normalizeSha256(doc.sha256);
    if (given && given !== sha) {
      f.shaMismatch++;
      log(`warning: _storage ${doc._id}: sha256 in the snapshot (${given}) differs from its bytes (${sha}); the bytes win`);
    }
    for (const shard of targets) {
      const q = new URLSearchParams({ shard, sha256: sha, ...(typeof doc.contentType === "string" ? { contentType: doc.contentType } : {}) });
      try {
        await admin.call("PUT", `/api/_ember/import/blob?${q}`, new Uint8Array(bytes), { "content-length": String(bytes.length) });
      } catch (e) {
        if ((e as { code?: string }).code === "files_unavailable") {
          bucketless = true;
          report.warnings.push("this deployment has no files bucket (resources.files in ember.json): _storage was not imported");
          log("warning: no files bucket: _storage is not imported");
          break;
        }
        throw e;
      }
      f.uploads++;
      let list = rows.get(shard);
      if (!list) rows.set(shard, (list = []));
      list.push({ id: doc._id, sha256: sha, size: bytes.length, contentType: typeof doc.contentType === "string" ? doc.contentType : null, createdAt: doc._creationTime });
      if (list.length >= 200) await flush(shard);
    }
    if (!bucketless) f.imported++;
    if (state && line % 200 === 0) {
      for (const s of [...rows.keys()]) await flush(s);
      state.files.line = line;
      state.files.imported = f.imported;
      save();
    }
  }
  for (const s of [...rows.keys()]) await flush(s);
  if (state && !bucketless) {
    state.files = { line, done: true, imported: f.imported };
    save();
  }
  log(`_storage: ${f.entries} entries, ${f.imported} imported, ${f.skipped} not referenced (skipped), ${f.missingBytes} without bytes`);
}

// ------------------------------------------------------------------------------------------------ verify

export type VerifyMismatch = { table: string; shard: string; expected: { count: number; sum: string }; actual: { count: number; sum: string } };

export interface VerifyReport {
  ok: boolean;
  compared: number;
  mismatches: VerifyMismatch[];
  /** Snapshot notes (e.g. a storage entry whose declared sha256 is not its bytes': the import stored the bytes'). */
  warnings: string[];
}

/** Recomputes what the import sends and compares, per table and shard, counts and the order-independent hash. */
export async function verifyConvex(o: { project: Project; zip: string; target: ImportTarget; only?: string[]; log?: (l: string) => void }): Promise<VerifyReport> {
  const log = o.log ?? (() => {});
  const { manifest, config, documentSize } = await loadImport(o.project);
  const snap = await openConvexSnapshot(o.zip);
  try {
    const p = plan(snap, manifest, config);
    const prefixes = new Map(Object.entries(manifest.tables).map(([n, t]) => [t.idPrefix, n]));
    const tableOfId = (id: string) => {
      const e = parseId(id);
      if (e) return prefixes.get(e.prefix);
      const n = convexTableNumber(id);
      return n === undefined ? undefined : p.foreignIds.convex?.[String(n)];
    };
    const pipe = makePipeline(manifest, config, p.tables);
    const only = o.only?.length ? new Set(o.only) : null;
    const expected = new Map<string, DocSetHash>();
    const key = (t: string, s: string) => `${t}\u0000${s}`;
    const shards = new Set<string>();
    const refs = new Map<string, Set<string>>();
    for (const table of pipe.order) {
      const shape = documentShape(manifest, table);
      for await (const text of snap.zip.lines(snap.tables.get(table)!)) {
        const r = pipe.route(table, JSON.parse(text) as Record<string, unknown>);
        if (!r.shard) continue;
        // What the shard refused is not expected there (the import reported it as invalid).
        const doc = checkImportDoc(table, shape, r.doc, { tableOfId, documentSize });
        if (typeof doc === "string") continue;
        shards.add(r.shard);
        for (const id of collectFiles(shape, r.doc)) {
          let s = refs.get(id);
          if (!s) refs.set(id, (s = new Set()));
          s.add(r.shard);
        }
        if (only && !only.has(table)) continue;
        let h = expected.get(key(table, r.shard));
        if (!h) expected.set(key(table, r.shard), (h = new DocSetHash()));
        h.add(doc);
      }
    }
    const warnings: string[] = [];
    const withStorage = !!snap.storage && snap.blobs.size > 0 && (!only || only.has("_storage"));
    if (withStorage) {
      for await (const text of snap.zip.lines(snap.storage!)) {
        const doc = JSON.parse(text) as ImportDoc & { sha256?: unknown; contentType?: unknown };
        const blob = snap.blobs.get(doc._id);
        if (!blob) continue;
        const targets = storageTargets(config, refs, doc);
        if (!targets.length) continue;
        // As the import: the bytes' hash and length, not what the snapshot declares (a difference is only reported).
        const { sha256: sha, size } = await snap.zip.digest(blob);
        const given = normalizeSha256(doc.sha256);
        if (given && given !== sha) {
          warnings.push(`_storage ${doc._id}: sha256 in the snapshot (${given}) differs from its bytes (${sha}); the import stored the bytes' hash`);
          log(`warning: ${warnings[warnings.length - 1]}`);
        }
        for (const s of targets) {
          shards.add(s);
          let h = expected.get(key("_storage", s));
          if (!h) expected.set(key("_storage", s), (h = new DocSetHash()));
          h.add(storageDigestDoc({ id: doc._id, sha256: sha, size, contentType: typeof doc.contentType === "string" ? doc.contentType : null }));
        }
      }
    }
    const admin = new AdminClient(o.target);
    const tables = [...p.tables.filter((t) => !only || only.has(t)), ...(withStorage ? ["_storage"] : [])];
    const mismatches: VerifyMismatch[] = [];
    let compared = 0;
    for (const shard of [...shards].sort()) {
      for (const table of tables) {
        const got = new DocSetHash();
        let after = 0;
        for (;;) {
          const page = await admin.call<{ count: number; sum: string; next: number | null }>("GET", `/api/_ember/import/hash?${new URLSearchParams({ shard, table, after: String(after), limit: "2000" })}`);
          got.merge(page);
          if (page.next === null) break;
          after = page.next;
        }
        const want = expected.get(key(table, shard)) ?? new DocSetHash();
        compared++;
        if (want.count !== got.count || want.sum !== got.sum) {
          mismatches.push({ table, shard, expected: { count: want.count, sum: want.sum }, actual: { count: got.count, sum: got.sum } });
          log(`MISMATCH ${table} @ ${shard}: snapshot ${want.count} documents, shard ${got.count}${want.count === got.count ? " (same count, different content)" : ""}`);
        }
      }
    }
    log(mismatches.length ? `${mismatches.length} of ${compared} (table, shard) pairs differ` : `ok: ${compared} (table, shard) pairs match`);
    return { ok: mismatches.length === 0, compared, mismatches, warnings };
  } finally {
    await snap.zip.close();
  }
}
