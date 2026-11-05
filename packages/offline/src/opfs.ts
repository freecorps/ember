// The page half of OPFS storage: a `StorageAdapter` whose calls run in the app's offline Worker (opfs-worker.ts),
// where SQLite-Wasm owns the OPFS files. Local results are watched there and streamed back. The Worker reports its
// `sync` specs on load, so they are declared once, in the Worker.
//
//   import { opfsStorage } from "@freecorps/ember-offline/opfs";
//   new EmberClient({
//     url,
//     storage: opfsStorage({ worker: new Worker(new URL("./ember-offline.worker.ts", import.meta.url), { type: "module" }) }),
//     optimisticUpdates: { "messages:send": addMessage },
//   });
//
// If OPFS or the Worker fails to start, `load()` rejects and the client carries on without offline storage
// (`storage_error`), as with any adapter.

import { RemoteStorage, type Endpoint } from "./remote.ts";

export interface OpfsStorageOptions {
  /** The Worker that calls `serveOpfsStorage` (or a factory for it). */
  worker: (Endpoint & { terminate?(): void }) | (() => Endpoint & { terminate?(): void });
  /** Terminate the Worker on `close()` (default true). */
  terminate?: boolean;
}

export class OpfsStorage extends RemoteStorage {
  private readonly worker: Endpoint & { terminate?(): void };
  private readonly failed: Promise<never>;

  constructor(private readonly options: OpfsStorageOptions) {
    const worker = typeof options.worker === "function" ? options.worker() : options.worker;
    super(worker);
    this.worker = worker;
    // A Worker that cannot load (bad URL, syntax error, no module workers) fails the load instead of hanging it.
    let fail: (e: Error) => void = () => {};
    this.failed = new Promise<never>((_, reject) => (fail = reject));
    this.failed.catch(() => undefined);
    const w = worker as unknown as { addEventListener?(t: string, l: (e: { message?: string }) => void): void };
    w.addEventListener?.("error", (e) => fail(new Error(`offline worker failed: ${e?.message ?? "error"}`)));
  }

  override async load() {
    return await Promise.race([super.load(), this.failed]);
  }

  override async close(): Promise<void> {
    await this.shutdown();
    if (this.options.terminate !== false) this.worker.terminate?.();
  }
}

/** Offline storage on SQLite-Wasm over OPFS, run in a dedicated Worker (see opfs-worker.ts). */
export function opfsStorage(options: OpfsStorageOptions): OpfsStorage {
  return new OpfsStorage(options);
}
