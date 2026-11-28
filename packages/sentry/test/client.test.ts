// `@freecorps/ember-sentry/client`: the small SDK builds envelopes the ingest endpoint accepts (through the real
// handler here), with the DSN's key in the query and a CORS-simple content type.
import { afterEach, describe, expect, it } from "vitest";
import { captureException, captureMessage, close, init, parseDsn } from "../src/client.ts";
import { handleIngest, TokenBuckets, type QueuedEvent } from "../src/ingest.ts";
import { FakeQueue, KEY, MemoryR2 } from "./fakes.ts";

afterEach(() => close());

function endpoint() {
  const queue = new FakeQueue<QueuedEvent>();
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(input), init);
    requests.push(req.clone());
    return handleIngest(req, { config: { projects: [{ id: "web", keys: [KEY] }] }, install: "sentry", env: { EMBER_Q_SENTRY_EVENTS: queue, EMBER_FILES: new MemoryR2() }, buckets: new TokenBuckets() });
  }) as typeof fetch;
  return { queue, requests, fetch };
}

describe("client", () => {
  it("parses a DSN into the envelope URL", () => {
    expect(parseDsn(`https://${KEY}@app.test/sentry/web`)).toEqual({ key: KEY, url: `https://app.test/sentry/api/web/envelope/?sentry_key=${KEY}&sentry_version=7` });
    expect(parseDsn(`https://${KEY}@app.test/web`).url).toBe(`https://app.test/api/web/envelope/?sentry_key=${KEY}&sentry_version=7`);
    expect(() => parseDsn("https://app.test/sentry/web")).toThrow(/invalid DSN/);
  });

  it("captureException and captureMessage reach the queue; beforeSend may drop; nothing before init", async () => {
    const ep = endpoint();
    expect(await captureException(new Error("early"))).toBeNull();
    init({ dsn: `https://${KEY}@app.test/sentry/web`, release: "web@3", environment: "prod", fetch: ep.fetch, globalHandlers: false, beforeSend: (e) => (e.message === "drop me" ? null : e) });
    const id = await captureException(new TypeError("x is undefined"), { tags: { route: "/cart" } });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await captureMessage("hello", "warning")).toMatch(/^[0-9a-f]{32}$/);
    expect(await captureMessage("drop me")).toBeNull();
    expect(ep.requests[0]!.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    const [err, msg] = ep.queue.sent;
    expect(err).toMatchObject({ project: "web", id, event: { release: "web@3", environment: "prod", tags: { route: "/cart" }, exception: { values: [{ type: "TypeError", value: "x is undefined" }] } } });
    expect(msg!.event).toMatchObject({ message: "hello", level: "warning" });
    expect(ep.queue.sent).toHaveLength(2);
  });
});
