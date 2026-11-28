// An app with the sentry component over the real engine (`emberTest({ app })`), fake R2 / Analytics Engine bindings,
// and fakes standing in for the email and push components: the alert handler sends through them like an app would
// (`email.send(ctx, { ...alertEmail(alert) })`, `push.send(ctx, { ...alertPush(alert) })`).
import { defineApp, defineSchema, defineTable, internalMutationGeneric, queryGeneric, unsafeRef, v, type MutationCtx } from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import { alertEmail, alertPush, sentry, vAlertArgs, type QueuedEvent, type SentryAlert, type SentryEvent, type SentryInstallConfig } from "../src/index.ts";
import { FakeAnalytics, KEY, MemoryR2 } from "./fakes.ts";

const schema = defineSchema({
  tables: {
    outbox: defineTable({ to: v.string(), subject: v.string(), text: v.string() }),
    pushes: defineTable({ userId: v.string(), title: v.string(), body: v.string(), kind: v.string() }),
  },
});

/** The email component's helper shape (`new Email(components.email).send(ctx, msg)`), recording instead of sending. */
const email = { send: (ctx: MutationCtx, m: { to: string; subject: string; text: string }) => void ctx.db.insert("outbox" as never, m as never) };
/** The push component's helper shape (`new PushNotifications(components.push).send(ctx, ...)`). */
const push = { send: (ctx: MutationCtx, m: { userIds: string[]; title: string; body: string; data: Record<string, string> }) => m.userIds.forEach((userId) => void ctx.db.insert("pushes" as never, { userId, title: m.title, body: m.body, kind: m.data.kind! } as never)) };

const modules = {
  alerts: {
    notify: internalMutationGeneric({
      args: vAlertArgs,
      handler: (ctx: MutationCtx, { alert }: { alert: SentryAlert }) => {
        const mail = alertEmail(alert, { link: `https://dash.test/issues/${alert.issueId}` });
        email.send(ctx, { to: "oncall@example.com", subject: mail.subject, text: mail.text });
        push.send(ctx, { userIds: ["oncall"], ...alertPush(alert) });
      },
    }),
  },
  probe: {
    outbox: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("outbox").collect().map((r: any) => ({ subject: r.subject, text: r.text })) }),
    pushes: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("pushes").collect().map((r: any) => ({ title: r.title, body: r.body, kind: r.kind })) }),
  },
};

export const fn = (name: string) => unsafeRef(`@sentry/${name}`);
/** The upload routes' token in the harness env. */
export const UPLOAD_TOKEN = "upload-token-for-tests";

export function harness(config: Partial<SentryInstallConfig> = {}, now = Date.UTC(2026, 10, 20, 12)) {
  const bucket = new MemoryR2();
  const ae = new FakeAnalytics();
  const app = defineApp().use(sentry, { config: { projects: [{ id: "web", keys: [KEY] }], ...config } });
  const t = emberTest({ schema, modules, app, env: { EMBER_FILES: bucket, EMBER_SENTRY_SENTRY_AE: ae, ALERT_SECRET: "whsec_test", EMBER_SENTRY_UPLOAD_TOKEN: UPLOAD_TOKEN }, now });
  // Internal component actions (the consumer, retention) as the scheduler and the Queue run them: `t.action` only
  // takes public ones, `_action` is the harness's internal path (the one its scheduler uses).
  const internalAction = (name: string, args: unknown) => (t as unknown as { _action(n: string, a: unknown, s: string): Promise<unknown> })._action(`@sentry/${name}`, args, "global:main");
  let n = 0;
  const msg = (e: SentryEvent, project = "web"): QueuedEvent => ({ v: 1, project, id: (e.event_id ??= (++n).toString(16).padStart(32, "0")), receivedAt: t.now(), event: e });
  const consume = (events: SentryEvent[], project = "web") => internalAction("lib:consume", { messages: events.map((e) => msg(e, project)) }) as Promise<{ events: number; issues: number; created: number; alerts: number; symbolicated: number; object: string | null }>;
  const issues = async () => ((await t.query(fn("dashboard:issues"), { paginationOpts: { numItems: 100, cursor: null } })) as { page: Array<{ _id: string; title: string; count: number; status: string; firstSeen: number; lastSeen: number; level: string; release: string | null }> }).page;
  return { t, bucket, ae, app, consume, issues, msg, internalAction };
}

/** An error event like `@sentry/react` sends: one exception, frames oldest first. */
export function errorEvent(o: { type?: string; value?: string; fn?: string; file?: string; line?: number; release?: string; level?: string; at?: number } = {}): SentryEvent {
  return {
    level: o.level ?? "error",
    platform: "javascript",
    ...(o.release ? { release: o.release } : {}),
    ...(o.at ? { timestamp: o.at / 1000 } : {}),
    exception: {
      values: [
        {
          type: o.type ?? "TypeError",
          value: o.value ?? "Cannot read properties of undefined (reading 'id')",
          stacktrace: { frames: [{ filename: "app.js", abs_path: `https://app.test/${o.file ?? "app.js"}`, function: "main", lineno: 1, colno: 1, in_app: true }, { filename: o.file ?? "app.js", abs_path: `https://app.test/${o.file ?? "app.js"}`, function: o.fn ?? "loadUser", lineno: o.line ?? 10, colno: 5, in_app: true }] },
        },
      ],
    },
  };
}
