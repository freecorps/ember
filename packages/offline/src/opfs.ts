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
  /**
   * How long `close()` waits for the Worker to close its database (default 5000 ms). A Worker that reported an
   * error is not waited for at all; one that went silent is given up on after this, then terminated.
   */
  closeTimeoutMs?: number;
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
    // After a successful load too: a Worker that reports an error (crash, wasm abort, OOM) is not trusted again —
    // calls in flight and later ones fail with the error, watches get it once, and the Worker is terminated so it
    // releases its OPFS handles (and, with several tabs, the leader lock for the next tab).
    const w = worker as unknown as { addEventListener?(t: string, l: (e: { message?: string }) => void): void };
    w.addEventListener?.("error", (e) => {
      const error = new Error(`offline worker failed: ${e?.message ?? "error"}`);
      fail(error);
      this.setUnavailable(error, { permanent: true });
      this.terminate();
    });
  }

  private terminated = false;
  private terminate(): void {
    if (this.terminated || this.options.terminate === false) return;
    this.terminated = true;
    this.worker.terminate?.();
  }

  override async load() {
    return await Promise.race([super.load(), this.failed]);
  }

  override async close(): Promise<void> {
    // A dead Worker never answers "close": stop waiting when it has failed or after the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, this.options.closeTimeoutMs ?? 5000)));
    try {
      await Promise.race([this.shutdown(), this.failed.catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
      this.detach();
      this.terminate();
    }
  }
}

/** Offline storage on SQLite-Wasm over OPFS, run in a dedicated Worker (see opfs-worker.ts). */
export function opfsStorage(options: OpfsStorageOptions): OpfsStorage {
  return new OpfsStorage(options);
}
