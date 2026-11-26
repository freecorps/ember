/**
 * Fake webhook receivers for the workerd test, running in Node behind miniflare's `outboundService`: every `fetch` the
 * Worker or its Durable Objects make lands here. `ok.hooks.test` answers 200, `flaky.hooks.test` 503 twice then 200,
 * `gone.hooks.test` 410. `https://fake.test/__log` returns what they received (headers and the raw body).
 */
export function createReceivers() {
  const log: Array<{ host: string; path: string; headers: Record<string, string>; body: string }> = [];
  let flaky = 0;
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host === "fake.test" && url.pathname === "/__log") return Response.json(log);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    log.push({ host: url.host, path: url.pathname, headers, body: await request.text() });
    if (url.host === "ok.hooks.test") return new Response("thanks", { status: 200 });
    if (url.host === "flaky.hooks.test") return ++flaky <= 2 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
    if (url.host === "gone.hooks.test") return new Response("no such hook", { status: 410 });
    return new Response(`unexpected outbound fetch to ${url.host}`, { status: 599 });
  };
  return { handler };
}
