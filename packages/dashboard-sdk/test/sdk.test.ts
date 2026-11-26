// The page side of the dashboard bridge over a fake pair of windows: the handshake pins the dashboard's origin,
// requests and responses are correlated by id, messages from any other window (or origin) are ignored, and the theme
// lands on <html> as CSS variables. The inline script (EMBED_SDK_SCRIPT) is the same code.
import { afterEach, describe, expect, test, vi } from "vitest";
import { connect, DashboardError, EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION, EMBED_SDK_SCRIPT, embedPage, type SdkWindow } from "../src/index.ts";

const HOST = "https://dash.example";
type Listener = (e: { data: unknown; origin: string; source: unknown }) => void;

function pair(o: { resizeObserver?: boolean } = {}) {
  const listeners = new Set<Listener>();
  const sent: Array<{ msg: Record<string, unknown>; target: string }> = [];
  const parent = { postMessage: (msg: unknown, target: string) => void sent.push({ msg: structuredClone(msg) as Record<string, unknown>, target }) };
  const style = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = { style: { setProperty: (k: string, v: string) => void style.set(k, v), colorScheme: "" }, setAttribute: (k: string, v: string) => void attrs.set(k, v), scrollHeight: 321 };
  let observed: (() => void) | null = null;
  const win: SdkWindow = {
    parent,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    document: { documentElement: root, body: {} },
    ...(o.resizeObserver
      ? {
          ResizeObserver: class {
            constructor(cb: () => void) {
              observed = cb;
            }
            observe() {}
            disconnect() {}
          },
        }
      : {}),
  };
  const deliver = (data: Record<string, unknown>, from: { origin?: string; source?: unknown } = {}) => {
    const msg = { ember: EMBED_PROTOCOL, v: EMBED_PROTOCOL_VERSION, ...data };
    for (const l of [...listeners]) l({ data: structuredClone(msg), origin: from.origin ?? HOST, source: "source" in from ? from.source : parent });
  };
  const welcome = (from?: { origin?: string; source?: unknown }) =>
    deliver({ type: "welcome", theme: { mode: "dark", vars: { "--fg": "#eee", "--bg": "#111", "bad name": "x", "--x": 3 } }, context: { project: "chat", env: "prod", shard: "org:acme", dashboard: "agent", block: "play", functions: ["dashboard:threads"], role: "admin" } }, from);
  return { win, parent, sent, deliver, welcome, style, attrs, root, listeners, grow: () => observed?.() };
}

const requests = (sent: Array<{ msg: Record<string, unknown>; target: string }>) => sent.filter((s) => s.msg.type === "request");

afterEach(() => vi.useRealTimers());

describe("connect()", () => {
  test("handshake: hellos carry nothing; requests wait for the welcome, then go to the welcome's origin only", async () => {
    const p = pair();
    const dash = connect({ window: p.win });
    expect(p.sent).toEqual([{ msg: { ember: EMBED_PROTOCOL, v: 1, type: "hello" }, target: "*" }]);
    const q = dash.query("dashboard:threads", { n: 1 });
    // Nothing but the hello leaves before the dashboard's origin is known.
    expect(requests(p.sent)).toEqual([]);
    p.welcome();
    expect(await dash.context).toMatchObject({ dashboard: "agent", block: "play", functions: ["dashboard:threads"] });
    const [r] = requests(p.sent);
    expect(r).toEqual({ msg: { ember: EMBED_PROTOCOL, v: 1, type: "request", id: "r1", op: "query", name: "dashboard:threads", args: { n: 1 } }, target: HOST });
    p.deliver({ type: "response", id: "r1", ok: true, value: [{ _id: "t1" }] });
    expect(await q).toEqual([{ _id: "t1" }]);
    // After the handshake, every message names the dashboard's origin, never "*".
    dash.ready();
    dash.resize(500);
    void dash.mutate("lib:send", {}).catch(() => undefined);
    const after = p.sent.slice(p.sent.findIndex((s) => s.msg.type === "request"));
    expect(after.map((s) => s.target)).toEqual([HOST, HOST, HOST, HOST]);
    expect(after.map((s) => s.msg.type)).toEqual(["request", "ready", "resize", "request"]);
    dash.close();
  });

  test("hellos repeat until the welcome, then stop", async () => {
    vi.useFakeTimers();
    const p = pair();
    const dash = connect({ window: p.win });
    vi.advanceTimersByTime(650);
    expect(p.sent.filter((s) => s.msg.type === "hello")).toHaveLength(4);
    p.welcome();
    vi.advanceTimersByTime(2000);
    expect(p.sent.filter((s) => s.msg.type === "hello")).toHaveLength(4);
    dash.close();
  });

  test("responses are matched by id (out of order); failures reject with the code", async () => {
    const p = pair();
    const dash = connect({ window: p.win });
    p.welcome();
    const a = dash.query("q:a");
    const b = dash.action<string>("q:b", { x: 1 });
    const c = dash.mutate("q:c");
    const ids = requests(p.sent).map((s) => s.msg.id);
    expect(ids).toEqual(["r1", "r2", "r3"]);
    expect(requests(p.sent).map((s) => s.msg.op)).toEqual(["query", "action", "mutate"]);
    p.deliver({ type: "response", id: "r2", ok: true, value: "B" });
    p.deliver({ type: "response", id: "r1", ok: true, value: "A" });
    p.deliver({ type: "response", id: "r3", ok: false, error: { code: "cancelled", message: "declined", data: { why: 1 } } });
    expect(await a).toBe("A");
    expect(await b).toBe("B");
    const err = await c.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DashboardError);
    expect(err).toMatchObject({ code: "cancelled", message: "declined", data: { why: 1 } });
    // An unknown id, or a second answer to a settled one, changes nothing.
    p.deliver({ type: "response", id: "r1", ok: false, error: { code: "x", message: "late" } });
    p.deliver({ type: "response", id: "nope", ok: true, value: 1 });
    // Bad input is refused before anything is sent.
    await expect(dash.query("")).rejects.toMatchObject({ code: "bad_request" });
    await expect(dash.query("q:a", [] as never)).rejects.toMatchObject({ code: "bad_request" });
    dash.close();
  });

  test("ignores messages from other windows and, after the handshake, from other origins", async () => {
    const p = pair();
    const dash = connect({ window: p.win });
    const other = { postMessage() {} };
    // A welcome from another frame (or the page itself) does not pin anything.
    p.welcome({ source: other, origin: "https://evil.example" });
    p.welcome({ source: null, origin: "https://evil.example" });
    // An opaque origin is never pinned.
    p.welcome({ origin: "null" });
    const q = dash.query("q:a");
    expect(requests(p.sent)).toEqual([]);
    p.welcome();
    const [r] = requests(p.sent);
    expect(r!.target).toBe(HOST);
    // A forged answer from another window or origin is dropped; the real one resolves.
    p.deliver({ type: "response", id: "r1", ok: true, value: "forged" }, { source: other });
    p.deliver({ type: "response", id: "r1", ok: true, value: "forged" }, { origin: "https://evil.example" });
    p.deliver({ type: "theme", theme: { mode: "light", vars: { "--fg": "red" } } }, { origin: "https://evil.example" });
    // Not the protocol, or another version: ignored.
    for (const l of p.listeners) l({ data: { type: "response", id: "r1", ok: true, value: "no protocol" }, origin: HOST, source: p.parent });
    p.deliver({ type: "response", id: "r1", ok: true, value: "v2", v: 2 });
    p.deliver({ type: "response", id: "r1", ok: true, value: "real" });
    expect(await q).toBe("real");
    expect(p.style.get("--fg")).toBe("#eee");
    // A second welcome does not move the pinned origin.
    p.welcome({ origin: "https://other.example" });
    void dash.query("q:b").catch(() => undefined);
    expect(requests(p.sent).at(-1)!.target).toBe(HOST);
    dash.close();
  });

  test("theme: valid CSS variables on <html>, data-theme and color-scheme; updates reach onTheme", () => {
    const p = pair();
    const dash = connect({ window: p.win });
    const seen: string[] = [];
    dash.onTheme((t) => seen.push(t.mode));
    expect(dash.theme).toBeNull();
    p.welcome();
    expect(dash.theme).toEqual({ mode: "dark", vars: { "--fg": "#eee", "--bg": "#111" } });
    expect([...p.style]).toEqual([["--fg", "#eee"], ["--bg", "#111"]]);
    expect(p.attrs.get("data-theme")).toBe("dark");
    expect(p.root.style.colorScheme).toBe("dark");
    p.deliver({ type: "theme", theme: { mode: "light", vars: { "--fg": "#111" } } });
    expect(seen).toEqual(["dark", "light"]);
    expect(p.style.get("--fg")).toBe("#111");
    expect(p.attrs.get("data-theme")).toBe("light");
    // A late subscriber gets the current theme at once.
    const late: string[] = [];
    const off = dash.onTheme((t) => late.push(t.mode));
    off();
    p.deliver({ type: "theme", theme: { mode: "dark", vars: {} } });
    expect(late).toEqual(["light"]);
    dash.close();
    // applyTheme: false leaves the document alone.
    const q = pair();
    const plain = connect({ window: q.win, applyTheme: false });
    q.welcome();
    expect(q.style.size).toBe(0);
    expect(plain.theme?.mode).toBe("dark");
    plain.close();
  });

  test("resize: the given height or the document's, sent once per change; auto-resize through ResizeObserver", () => {
    const p = pair({ resizeObserver: true });
    const dash = connect({ window: p.win });
    p.welcome();
    dash.resize();
    dash.resize();
    dash.resize(480.2);
    p.root.scrollHeight = 600;
    p.grow();
    expect(p.sent.filter((s) => s.msg.type === "resize").map((s) => s.msg.height)).toEqual([321, 481, 600]);
    dash.close();
  });

  test("queries time out; close() rejects what is pending and stops listening", async () => {
    vi.useFakeTimers();
    const p = pair();
    const dash = connect({ window: p.win, queryTimeoutMs: 1000 });
    p.welcome();
    const q = dash.query("q:slow");
    const w = dash.mutate("q:write");
    vi.advanceTimersByTime(1001);
    await expect(q).rejects.toMatchObject({ code: "timeout" });
    // A write waits for the person: no timeout.
    vi.advanceTimersByTime(60_000);
    dash.close();
    await expect(w).rejects.toMatchObject({ code: "disconnected" });
    expect(p.listeners.size).toBe(0);
    await expect(dash.query("q:a")).rejects.toMatchObject({ code: "disconnected" });
  });

  test("outside a browser, connect() says where it runs", () => {
    expect(() => connect()).toThrow(/runs in the browser/);
  });
});

describe("EMBED_SDK_SCRIPT and embedPage()", () => {
  test("the inline script is the same SDK: defines EmberDashboard.connect on the window it runs in", async () => {
    expect(EMBED_SDK_SCRIPT).not.toMatch(/\bimport\b|\brequire\(|__name\(/);
    const p = pair();
    const fake = p.win as SdkWindow & { EmberDashboard?: { connect: typeof connect } };
    new Function("window", EMBED_SDK_SCRIPT)(fake);
    const dash = fake.EmberDashboard!.connect({ window: p.win });
    p.welcome();
    const q = dash.query("q:a");
    p.deliver({ type: "response", id: "r1", ok: true, value: 42 });
    expect(await q).toBe(42);
    dash.close();
  });

  test("embedPage inlines the SDK before the page's script, escapes the title, refuses an early </script>", () => {
    const html = embedPage({ title: "<Agent & co>", body: "<main id=app></main>", style: "main{gap:4px}", script: "EmberDashboard.connect().ready();" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>&#60;Agent &#38; co&#62;</title>");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toEqual([EMBED_SDK_SCRIPT, "EmberDashboard.connect().ready();"]);
    expect(html).toContain("main{gap:4px}");
    expect(() => embedPage({ title: "x", script: "'</script>'" })).toThrow(/must not contain <\/script/);
    expect(() => embedPage({ title: "x", script: "", style: "</STYLE>" })).toThrow(/<\/style/);
  });
});
