// Shared by the examples' workerd tests (not a package): an `EmberClient` that talks to the test Worker in-process,
// the same client class the React hooks use in the browser.
import { SELF } from "cloudflare:test";
import { EmberClient, type EmberClientOptions, type FunctionReference, type QuerySnapshot, type WebSocketLike } from "@freecorps/ember-client";

/** WHATWG-style socket over `SELF.fetch` + `Upgrade: websocket`. */
export class SelfWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  private ws: WebSocket | null = null;

  constructor(url: string) {
    SELF.fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } }).then(
      (res) => {
        const ws = res.webSocket;
        if (!ws || this.readyState !== 0) return this.closed(1006);
        ws.accept();
        this.ws = ws;
        this.readyState = 1;
        ws.addEventListener("message", (e) => this.onmessage?.({ data: e.data }));
        ws.addEventListener("close", (e) => this.closed(e.code));
        ws.addEventListener("error", (e) => this.onerror?.(e));
        this.onopen?.({});
      },
      () => this.closed(1006),
    );
  }
  private closed(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  send(data: string): void {
    this.ws!.send(data);
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    try {
      this.ws?.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

export const selfFetch = ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as any, init as any)) as typeof fetch;

/** An `EmberClient` against the test Worker. Close it at the end of the test. */
export function testClient(opts: Partial<EmberClientOptions> = {}): EmberClient {
  return new EmberClient({
    url: "http://ember.test",
    WebSocket: SelfWebSocket,
    fetch: selfFetch,
    connectivity: null,
    heartbeat: false,
    defaultShard: "global:main",
    ...opts,
  });
}

/** Records every snapshot of a live query. `last()` is the newest one. */
export function watch<Q extends FunctionReference<"query">>(client: EmberClient, ref: Q, args: Q["_args"]) {
  const seen: QuerySnapshot<Q["_returnType"]>[] = [];
  const stop = client.subscribe(ref, args, undefined, (s) => seen.push(s));
  return { seen, last: () => seen.at(-1), stop };
}
