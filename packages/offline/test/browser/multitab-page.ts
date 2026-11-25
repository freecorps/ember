// A test page for option `multiTab` of @freecorps/ember-client: an EmberClient on the browser's own WebSocket,
// BroadcastChannel and Web Locks, against the test's server (a FakeEmberServer behind a WebSocket bridge in Node).
// The test drives it through `window.t` (page.evaluate).
import { EmberClient, unsafeRef, type QuerySnapshot } from "@freecorps/ember-client";

const t = {
  roles: [] as string[],
  snaps: {} as Record<string, QuerySnapshot[]>,
  results: [] as unknown[],
  client: null as EmberClient | null,
  token: null as string | null,
  start({ url, token, name }: { url: string; token: string | null; name: string }) {
    t.token = token;
    t.client = new EmberClient({
      url,
      auth: () => t.token,
      connectivity: null,
      defaultShard: "org:acme",
      heartbeat: false,
      httpFirst: false,
      backoff: { initialMs: 20, maxMs: 200 },
      multiTab: { name, onRoleChange: (r) => t.roles.push(r) },
    });
  },
  sub(key: string, fn: string, args: Record<string, unknown>) {
    t.snaps[key] = [];
    t.client!.subscribe(unsafeRef<"query">(fn), args, {}, (s: QuerySnapshot) => t.snaps[key]!.push(s));
  },
  value(key: string) {
    const s = t.snaps[key]?.at(-1);
    return s?.status === "success" ? s.value : undefined;
  },
  /** Every value the subscription ever showed, from index `from`. */
  values(key: string, from = 0) {
    return (t.snaps[key] ?? []).slice(from).map((s) => (s.status === "success" ? s.value : null));
  },
  count: (key: string) => t.snaps[key]?.length ?? 0,
  mutate(fn: string, args: Record<string, unknown>) {
    void t.client!.mutation(unsafeRef<"mutation">(fn), args).then(
      (v) => t.results.push(v),
      (e: Error) => t.results.push({ error: e.message }),
    );
  },
  signIn(token: string | null) {
    t.token = token;
    t.client!.setAuth(token === null ? undefined : () => t.token);
  },
  role: () => t.client!.tabRole,
  clientId: () => t.client!.clientId,
  pending: () => t.client!.connectionState().pendingMutations,
};

(globalThis as unknown as { t: typeof t }).t = t;
