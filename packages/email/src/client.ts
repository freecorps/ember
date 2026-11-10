// Typed helper over an installed email component (like `PushNotifications`): synchronous inside queries and
// mutations (same transaction), Promises in actions.
//
//   const email = new Email(components.email);
//   export const signup = mutation({ args: {...}, handler: (ctx, a) => {
//     const userId = ctx.db.insert("users", a);
//     email.send(ctx, { from: "Acme <hello@acme.com>", to: a.email, template: { name: "welcome", data: { name: a.name } } });
//     return userId;
//   }});

import type { FunctionReference } from "@freecorps/ember-server";
import type { SendInput, SendResult } from "./component.ts";
import type { EmailStatus } from "./events.ts";

type Ref<T extends "query" | "mutation" | "action", A, R> = FunctionReference<T, "public", A, R>;
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type PageOpts = { numItems: number; cursor: string | null };

export type EmailRecord = SendInput & {
  _id: string;
  _creationTime: number;
  project: string;
  status: EmailStatus;
  sendAt: number;
  attempts: number;
  messageId?: string;
  sentAt?: number;
  lastEventAt?: number;
  error?: { code: string; message: string };
  suppressed?: string[];
};
export type ThreadRecord = {
  _id: string;
  mailbox: string;
  number: number;
  subject: string;
  contact: string;
  contactName?: string;
  status: "open" | "waiting" | "closed" | "spam";
  messageCount: number;
  unreadCount: number;
  lastMessageAt: number;
  snippet: string;
  assignee?: string;
  assigneeName?: string;
};

/** What `components.<name>` of the email component looks like (public functions). */
export interface EmailComponentApi {
  lib: {
    send: Ref<"mutation", SendInput, SendResult>;
    sendBatch: Ref<"mutation", { emails: SendInput[] }, SendResult[]>;
    cancel: Ref<"mutation", { id: string }, { ok: boolean; status: string }>;
    retry: Ref<"mutation", { id: string }, { ok: boolean; status: string }>;
    get: Ref<"query", { id: string }, EmailRecord | null>;
    list: Ref<"query", { project?: string; paginationOpts?: PageOpts }, Page<EmailRecord>>;
    events: Ref<"query", { id: string }, Array<Record<string, unknown>>>;
    eventsByMessage: Ref<"query", { messageId: string }, Array<Record<string, unknown>>>;
    stats: Ref<"query", { project?: string }, Record<string, number>>;
    suppress: Ref<"mutation", { project?: string; email: string; reason?: string }, string>;
    unsuppress: Ref<"mutation", { project?: string; email: string }, boolean>;
    suppressions: Ref<"query", { project?: string; paginationOpts?: PageOpts }, Page<{ email: string; reason: string; at: number }>>;
    upsertTemplate: Ref<"mutation", { project?: string; name: string; subject: string; html: string; text?: string; layout?: unknown }, string>;
    removeTemplate: Ref<"mutation", { project?: string; name: string }, boolean>;
    templates: Ref<"query", { project?: string }, Array<{ name: string; subject: string; html: string; text?: string; updatedAt: number }>>;
    render: Ref<"query", { project?: string; name: string; data?: unknown }, { subject: string; html: string; text: string } | null>;
    upsertMailbox: Ref<"mutation", { name: string; address: string; displayName?: string; autoReply?: { subject: string; text: string; html?: string } | null; catchAll?: boolean | null }, string>;
    removeMailbox: Ref<"mutation", { name: string }, boolean>;
    mailboxes: Ref<"query", {}, Array<{ _id: string; name: string; address: string; displayName?: string; autoReply?: unknown; catchAll?: boolean }>>;
    route: Ref<"query", { to: string }, { mailbox: string; tag: string | null } | null>;
    threads: Ref<"query", { mailbox: string; status?: string; paginationOpts?: PageOpts }, Page<ThreadRecord>>;
    /** The mailbox's Sent view: threads it wrote in, by its latest outbound message (`lastSentAt`); `next` → `before` (opaque). */
    sent: Ref<"query", { mailbox: string; limit?: number; before?: string }, { page: Array<ThreadRecord & { lastSentAt: number }>; next: string | null }>;
    thread: Ref<"query", { threadId: string }, { thread: ThreadRecord; messages: Array<Record<string, any>> } | null>;
    unread: Ref<"query", { mailboxes?: string[] }, Record<string, { unread: number; threads: number }>>;
    search: Ref<"query", { query: string; mailbox?: string; limit?: number }, Array<{ messageId: string; threadId: string; mailbox: string; direction: string; subject: string; from: { email: string; name?: string }; snippet: string; at: number }>>;
    markRead: Ref<"mutation", { threadId: string }, boolean>;
    setStatus: Ref<"mutation", { threadId: string; status: "open" | "waiting" | "closed" | "spam" }, string>;
    reply: Ref<"mutation", { threadId: string; text: string; html?: string; author?: string; cc?: string[]; sendAt?: number }, { emailId: string; messageId: string; status: string }>;
    note: Ref<"mutation", { threadId: string; text: string; author?: string }, string>;
    markUnread: Ref<"mutation", { threadId: string }, boolean>;
    assign: Ref<"mutation", { threadId: string; assignee: string | null; assigneeName?: string }, string | null>;
    compose: Ref<
      "mutation",
      { mailbox: string; to: string[]; cc?: string[]; subject: string; text: string; html?: string; author?: string },
      { threadId: string; emailId: string; messageId: string; status: string; number: number }
    >;
    recent: Ref<"query", { mailboxes: string[]; threads?: number }, { threads: ThreadRecord[]; messages: Array<Record<string, any>> }>;
  };
}

type SyncCtx = { runQuery(fn: any, args?: any): any; runMutation?(fn: any, args?: any): any };
type AsyncCtx = { runQuery(fn: any, args?: any): Promise<any>; runMutation(fn: any, args?: any): Promise<any> };

export class Email {
  constructor(readonly component: EmailComponentApi) {}

  private mut(ctx: SyncCtx | AsyncCtx, what: string) {
    if (!ctx.runMutation) throw new Error(`email.${what} needs a mutation or action ctx`);
    return ctx.runMutation.bind(ctx);
  }

  /** Queues an email; in a mutation it commits (or rolls back) with it. */
  send(ctx: SyncCtx, input: SendInput): SendResult;
  send(ctx: AsyncCtx, input: SendInput): Promise<SendResult>;
  send(ctx: SyncCtx | AsyncCtx, input: SendInput) {
    return this.mut(ctx, "send")(this.component.lib.send, input);
  }

  sendBatch(ctx: SyncCtx, emails: SendInput[]): SendResult[];
  sendBatch(ctx: AsyncCtx, emails: SendInput[]): Promise<SendResult[]>;
  sendBatch(ctx: SyncCtx | AsyncCtx, emails: SendInput[]) {
    return this.mut(ctx, "sendBatch")(this.component.lib.sendBatch, { emails });
  }

  cancel(ctx: SyncCtx, id: string): { ok: boolean; status: string };
  cancel(ctx: AsyncCtx, id: string): Promise<{ ok: boolean; status: string }>;
  cancel(ctx: SyncCtx | AsyncCtx, id: string) {
    return this.mut(ctx, "cancel")(this.component.lib.cancel, { id });
  }

  get(ctx: SyncCtx, id: string): EmailRecord | null;
  get(ctx: AsyncCtx, id: string): Promise<EmailRecord | null>;
  get(ctx: SyncCtx | AsyncCtx, id: string) {
    return ctx.runQuery(this.component.lib.get, { id });
  }

  /** Delivery status of an email (reactive in a query). */
  status(ctx: SyncCtx, id: string): EmailStatus | null {
    return (ctx.runQuery(this.component.lib.get, { id }) as EmailRecord | null)?.status ?? null;
  }
}
