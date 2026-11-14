// Files (R2) of one shard: the `_files` table, a preview, delete and upload. The preview never runs anything the
// project stores: bytes arrive as an octet-stream attachment; only raster images (shown from a blob: URL typed by
// an allowlist) and plain-text kinds (shown as text) are previewed; HTML, SVG, PDF and the rest are download only.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtBytes, fmtNum, fmtTime } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Loading, Mono, Problem, Table } from "../ui.tsx";

interface FileRow {
  id: string;
  sha256: string;
  size: number;
  content_type: string | null;
  refcount: number;
  state: string;
  created_at: number;
}

/** Previewed as an image: raster formats only (SVG can hold script; it is download only). */
const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
/** Previewed as text (never interpreted). */
const TEXT = /^(text\/plain|text\/csv|text\/markdown|application\/json|application\/x-ndjson)(;|$)/;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;

export function Files({ project, env, shard }: { project: string; env: string; shard: string }) {
  const s = useSession();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const list = useApi<{ rows: FileRow[]; cursor: string | null; done: boolean }>(path("/api/files", { project, env, shard, cursor, limit: 50 }));
  const [open, setOpen] = useState<FileRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<ApiError | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const r = await api.upload<{ value: { id: string; size: number } }>(path("/api/files/upload", { project, env, shard, contentType: file.type }), file);
      s.toast({ text: `Uploaded ${file.name} (${fmtBytes(r.value.size)})`, detail: r.value.id });
      list.reload();
    } catch (e) {
      setUploadError(e as ApiError);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <div className="toolbar">
        <span className="muted small">
          Files of <Mono>{shard}</Mono>. A file is deleted for good a while after its last reference goes (GC grace).
        </span>
        <span className="spacer" />
        {s.isAdmin && (
          <>
            <input ref={input} type="file" className="sr-only" id="upload" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button type="button" className="primary" disabled={uploading} onClick={() => input.current?.click()}>
              {uploading ? "Uploading…" : "Upload file"}
            </button>
          </>
        )}
        <button type="button" onClick={list.reload}>
          Refresh
        </button>
      </div>
      {uploadError && <Problem error={uploadError} />}
      {list.error ? (
        <Problem error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <Loading lines={6} />
      ) : (
        <>
          <Table
            label="Files"
            empty="No files on this shard."
            onRow={(i) => setOpen(list.data!.rows[i]!)}
            cols={[{ h: "File" }, { h: "Type" }, { h: "Size", num: true }, { h: "State" }, { h: "References", num: true }, { h: "Created" }]}
            rows={list.data.rows.map((f) => [
              <Mono>{f.id}</Mono>,
              <span className="mono">{f.content_type ?? "—"}</span>,
              fmtBytes(f.size),
              <Badge tone={f.state === "ready" ? "ok" : f.state === "failed" ? "bad" : f.state === "deleting" ? "warn" : undefined}>{f.state}</Badge>,
              fmtNum(f.refcount),
              <span title={fmtTime(f.created_at)}>{ago(f.created_at)}</span>,
            ])}
          />
          <div className="toolbar">
            <span className="spacer" />
            <button type="button" disabled={cursors.length < 2} onClick={() => setCursors((c) => c.slice(0, -1))}>
              ← Prev
            </button>
            <span className="muted small">page {cursors.length}</span>
            <button type="button" disabled={list.data.done} onClick={() => setCursors((c) => [...c, list.data!.cursor])}>
              Next →
            </button>
          </div>
        </>
      )}
      {open && <FileDialog key={open.id} project={project} env={env} shard={shard} file={open} onClose={() => setOpen(null)} onDeleted={() => (setOpen(null), list.reload())} />}
    </>
  );
}

function FileDialog({ project, env, shard, file, onClose, onDeleted }: { project: string; env: string; shard: string; file: FileRow; onClose: () => void; onDeleted: () => void }) {
  const s = useSession();
  const type = (file.content_type ?? "").toLowerCase();
  const kind = IMAGE.has(type) && file.size <= MAX_IMAGE ? "image" : TEXT.test(type) && file.size <= MAX_TEXT ? "text" : "none";
  const [preview, setPreview] = useState<{ url?: string; text?: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<ApiError | null>(null);
  const contentPath = path("/api/files/content", { project, env, shard, id: file.id });

  useEffect(() => {
    if (kind === "none" || file.state !== "ready") return;
    let url: string | null = null;
    let live = true;
    api.blob(contentPath).then(
      async ({ blob }) => {
        if (!live) return;
        // The type comes from the allowlist above, never from the response: a blob URL of an image type only.
        if (kind === "image") setPreview({ url: (url = URL.createObjectURL(new Blob([blob], { type }))) });
        else setPreview({ text: await blob.text() });
      },
      (e: unknown) => live && setError(e as ApiError),
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [contentPath, kind, type, file.state]);

  const download = async () => {
    try {
      const { blob } = await api.blob(contentPath);
      // Saved as a file (octet-stream): the browser never renders it.
      const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = file.id;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e as ApiError);
    }
  };

  return (
    <>
      <Dialog open={!deleting} onClose={onClose} title={<Mono>{file.id}</Mono>} wide>
        <div className="dialog-body">
          <dl className="kv">
            <dt>Type</dt>
            <dd className="mono">{file.content_type ?? "—"}</dd>
            <dt>Size</dt>
            <dd>{fmtBytes(file.size)}</dd>
            <dt>State</dt>
            <dd>{file.state}</dd>
            <dt>References</dt>
            <dd>{fmtNum(file.refcount)}</dd>
            <dt>sha256</dt>
            <dd className="mono small">{file.sha256}</dd>
          </dl>
          <div className="preview">
            {error ? (
              <Problem error={error} />
            ) : kind === "none" ? (
              <p className="muted">No preview for this type (only raster images and plain text are previewed; HTML, SVG and other documents are download only).</p>
            ) : file.state !== "ready" ? (
              <p className="muted">Not ready.</p>
            ) : !preview ? (
              <Loading />
            ) : preview.url ? (
              <img src={preview.url} alt={`Preview of ${file.id}`} />
            ) : (
              <pre className="json">{preview.text}</pre>
            )}
          </div>
        </div>
        <footer className="dialog-foot">
          {s.isAdmin && (
            <button type="button" className="danger-text" disabled={file.refcount > 0} title={file.refcount > 0 ? "Referenced by documents: delete those references first" : undefined} onClick={() => (setDeleteError(null), setDeleting(true))}>
              Delete…
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={() => void download()} disabled={file.state !== "ready"}>
            Download
          </button>
        </footer>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        title="Delete this file?"
        confirmLabel="Delete file"
        danger
        expected={s.isProtected(env) ? file.id : null}
        busy={busy}
        error={deleteError}
        onCancel={() => setDeleting(false)}
        onConfirm={async (typed) => {
          setBusy(true);
          try {
            await api.post("/api/files/delete", { project, env, shard, id: file.id, ...(typed ? { confirm: typed } : {}) });
            s.toast({ text: `Deleted ${file.id}` });
            onDeleted();
          } catch (e) {
            setDeleteError(e as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          <Mono>{file.id}</Mono> is removed from R2 at the next cleanup. The project refuses while a document references it.
        </p>
      </ConfirmDialog>
    </>
  );
}
