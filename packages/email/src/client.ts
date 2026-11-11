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
import type { CountBlock, CountsByStatus, SendInput, SendResult } from "./component.ts";
import type { TagColor } from "./schema.ts";
import type { EmailStatus } from "./events.ts";
import type { EmailSignature } from "./template.ts";

type Ref<T extends "query" | "mutation" | "action", A, R> = FunctionReference<T, "public", A, R>;
/** Days closed and spam conversations are kept (`upsertMailbox({ retention })`); a missing kind is kept forever. */
export type MailboxRetention = { closedDays?: number; spamDays?: number };
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type PageOpts = { numItems: number; cursor: string | null };
/** A file already in the shard's storage, sent with an inbox reply or composed email (`link: true` = no MIME part). */
export type InboxAttachment = { filename: string; contentType: string; file: string; link?: boolean };

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
  /** `unreadCount > 0` (absent only on threads from before 0.7 until the `lib:maintain` cron runs). */
  hasUnread?: boolean;
  /** Addresses only ever blind-copied on this thread (lowercased); replies never quote them. */
  blind?: string[];
  /** Ids of the mailbox's tags on the thread (absent: none). May hold a just-deleted tag's id for a moment: skip ids not in `tags`. */
  tags?: string[];
  /** Set while snoozed (`snooze`): out of the default lists and counts until `snoozedUntil` (ms). */
  snoozed?: boolean;
  snoozedUntil?: number;
};
/** A thread email waiting for its `sendAt` (`lib:scheduled`). `messageId` etc.: the thread message that holds it. */
export type ScheduledEmail = { emailId: string; sendAt: number; subject: string; to: Array<{ email: string; name?: string }>; cc?: Array<{ email: string; name?: string }>; messageId?: string; author?: string; snippet?: string };
/** Someone on a thread right now (`lib:presence`). */
export type PresenceRecord = { userId: string; name: string; state: "viewing" | "replying"; since: number };
/** A mailbox's tag (label). */
export type TagRecord = { _id: string; mailbox: string; name: string; color: TagColor; order: number; createdAt: number };
/** Kinds of `threadEvents` entries (see `activity`). */
export type ThreadEventKind = "status" | "assigned" | "tag_added" | "tag_removed" | "delivery" | "snoozed" | "unsnoozed" | "scheduled" | "scheduled_canceled";
/**
 * One entry of a thread's activity timeline. `author`: who did it (the `author` arg), absent for the system.
 * `data` by kind: `status` `{ from, to }`; `assigned` `{ from: string | null, fromName?, to: string | null, toName? }`;
 * `tag_added` / `tag_removed` `{ tag, name?, color? }`; `delivery` `{ emailId, status, previous, messageId?,
 * recipient?, bounceType?, error? }` (`messageId`: the thread message that sent it; absent for auto-replies);
 * `snoozed` `{ until, previous? }`; `unsnoozed` `{ reason: "time" | "inbound" | "manual", until }`; `scheduled`
 * `{ emailId, messageId, sendAt }`; `scheduled_canceled` `{ emailId, messageId? }`.
 */
export type ThreadEventRecord = { _id: string; threadId: string; mailbox: string; kind: ThreadEventKind; at: number; author?: string; data?: Record<string, any> };
/** `lib:counts`: the mailbox (all and by status), one assignee when asked, each tag of the mailbox. */
export type InboxCounts = CountsByStatus & { assignee?: CountsByStatus; tags: Record<string, CountsByStatus> };
export type { CountBlock, CountsByStatus, TagColor };
type ThreadStatus = "open" | "waiting" | "closed" | "spam";

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
    upsertMailbox: Ref<"mutation", { name: string; address: string; displayName?: string; autoReply?: { subject: string; text: string; html?: string } | null; catchAll?: boolean | null; retention?: MailboxRetention | null }, string>;
    removeMailbox: Ref<"mutation", { name: string }, boolean>;
    mailboxes: Ref<"query", {}, Array<{ _id: string; name: string; address: string; displayName?: string; autoReply?: unknown; catchAll?: boolean; retention?: MailboxRetention }>>;
    route: Ref<"query", { to: string }, { mailbox: string; tag: string | null } | null>;
    /** Newest message first. `assignee: null` = unassigned; `unread`: has unread messages or not; `tag`: a tag id. */
    threads: Ref<"query", { mailbox: string; status?: string; assignee?: string | null; unread?: boolean; tag?: string; snoozed?: boolean; paginationOpts?: PageOpts }, Page<ThreadRecord>>;
    counts: Ref<"query", { mailbox: string; assignee?: string | null }, InboxCounts>;
    /** The mailbox's Sent view: threads it wrote in, by its latest outbound message (`lastSentAt`); `next` → `before` (opaque). */
    sent: Ref<"query", { mailbox: string; limit?: number; before?: string }, { page: Array<ThreadRecord & { lastSentAt: number }>; next: string | null }>;
    thread: Ref<"query", { threadId: string }, { thread: ThreadRecord; messages: Array<Record<string, any>> } | null>;
    unread: Ref<"query", { mailboxes?: string[] }, Record<string, { unread: number; threads: number }>>;
    search: Ref<"query", { query: string; mailbox?: string; limit?: number }, Array<{
        messageId: string;
        threadId: string;
        mailbox: string;
        direction: string;
        subject: string;
        from: { email: string; name?: string };
        snippet: string;
        at: number;
        /** The thread's state, so a client can act on the hit like a list row. */
        status: ThreadStatus;
        unreadCount: number;
        assignee?: string;
        assigneeName?: string;
        snoozedUntil?: number;
        tags: string[];
      }>
    >;
    markRead: Ref<"mutation", { threadId: string }, boolean>;
    setStatus: Ref<"mutation", { threadId: string; status: ThreadStatus; author?: string }, string>;
    deleteThread: Ref<"mutation", { threadId: string }, { deleted: boolean; mailbox?: string; canceled?: number }>;
    /**
     * `text` is the text/plain part. `bodyHtml` is the composer's rich body (a fragment, sanitized), `html` a whole
     * document used as is (not both). `signature` goes after the body, `quoteHeader` (localized attribution line)
     * above the quoted last inbound message.
     */
    reply: Ref<"mutation", { threadId: string; text: string; html?: string; bodyHtml?: string; signature?: EmailSignature; quoteHeader?: string; author?: string; cc?: string[]; bcc?: string[]; sendAt?: number; attachments?: InboxAttachment[] }, { emailId: string; messageId: string; status: string }>;
    note: Ref<"mutation", { threadId: string; text: string; author?: string }, string>;
    markUnread: Ref<"mutation", { threadId: string }, boolean>;
    assign: Ref<"mutation", { threadId: string; assignee: string | null; assigneeName?: string; author?: string }, string | null>;
    compose: Ref<
      "mutation",
      { mailbox: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; bodyHtml?: string; signature?: EmailSignature; author?: string; sendAt?: number; attachments?: InboxAttachment[] },
      { threadId: string; emailId: string; messageId: string; status: string; number: number }
    >;
    recent: Ref<"query", { mailboxes: string[]; threads?: number }, { threads: ThreadRecord[]; messages: Array<Record<string, any>> }>;
    tags: Ref<"query", { mailbox: string }, TagRecord[]>;
    createTag: Ref<"mutation", { mailbox: string; name: string; color?: TagColor; order?: number }, string>;
    updateTag: Ref<"mutation", { tagId: string; name?: string; color?: TagColor; order?: number }, string>;
    deleteTag: Ref<"mutation", { tagId: string }, { deleted: boolean }>;
    /** These three return the thread's tags as written. */
    setTags: Ref<"mutation", { threadId: string; tags: string[]; author?: string }, string[]>;
    addTag: Ref<"mutation", { threadId: string; tag: string; author?: string }, string[]>;
    removeTag: Ref<"mutation", { threadId: string; tag: string; author?: string }, string[]>;
    /** `until` (ms, future, ≤ 366 days) or `null` to wake now; returns `until`. */
    snooze: Ref<"mutation", { threadId: string; until: number | null; author?: string }, number | null>;
    /** The thread's emails still `scheduled`, soonest first. */
    scheduled: Ref<"query", { threadId: string }, ScheduledEmail[]>;
    /** Cancels a `scheduled`/`queued` email and removes its thread message (an emptied composed thread is deleted). */
    cancelScheduled: Ref<"mutation", { emailId: string; author?: string }, { ok: boolean; status: string; messageId?: string; threadDeleted?: true }>;
    /** Heartbeat (~every 10 s) or `state: null` to leave; the row expires `ttlMs` (default 30 s, 5..120 s) after the last one. */
    setPresence: Ref<"mutation", { threadId: string; userId: string; name: string; state: "viewing" | "replying" | null; ttlMs?: number }, null>;
    presence: Ref<"query", { threadId: string }, PresenceRecord[]>;
    /** Oldest first: the latest `limit` (default 200, at most 1000) entries. */
    activity: Ref<"query", { threadId: string; limit?: number }, ThreadEventRecord[]>;
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
