# @freecorps/ember-email

Email as an [Ember](https://github.com/freecorps/ember) component, on Cloudflare Email Service (sending) and Email
Routing (receiving). It runs in your own Cloudflare account.

```ts
// ember/ember.config.ts
import { defineApp, createFunctionHandle } from "@freecorps/ember-server";
import { email } from "@freecorps/ember-email";

export default defineApp().use(email, {
  config: {
    domains: ["acme.com"],                                 // inbound domains routed to this Worker
    rateLimit: { rate: 100, period: 60_000 },              // per project
    hooks: { onInbound: createFunctionHandle("support:onInbound") },
  },
});
```

```ts
// ember/users.ts
import { Email } from "@freecorps/ember-email";
import { components, mutation } from "./_generated/server";
const email = new Email(components.email);

export const signup = mutation({
  args: { address: v.string(), name: v.string() },
  handler: (ctx, a) => {
    const id = ctx.db.insert("users", a);
    // Commits (or rolls back) with the insert; delivered by an action right after.
    email.send(ctx, { from: "Acme <hello@acme.com>", to: a.address, template: { name: "welcome", data: { name: a.name } }, idempotencyKey: `welcome:${id}` });
    return id;
  },
});
```

## What it does

- **Send.** `lib:send` / `email.send(ctx, ...)` is a mutation: atomic with the caller, optionally `sendAt`. It also
  handles idempotency keys per project, suppressions per project (hard bounces and complaints are added
  automatically), and a per-project token-bucket rate limit (nested `rateLimit` component, same transaction).
  Delivery goes through the `send_email` binding (the deploy adds it) or the REST API, with retries. Headers the
  provider refuses are dropped, keeping threading and `X-` headers.
- **Templates** are stored in the shard and use a small Mustache-like engine (`{{var}}`, `{{{raw}}}`, `#if`/`#each`)
  with a responsive layout (`emailLayout`: a card on a grey page). React Email works too: render it in an action and
  pass `html`.
- **Layouts:** transactional mail (stored templates with a layout, through `lib:send` or an HTTP API on it) gets
  `emailLayout`. Mail a person writes from the inbox (`reply`, `compose`, mailbox auto-replies) gets
  `conversationLayout` instead: a plain document like a mail client's, with no background, card, border or forced
  text color (so dark-mode clients recolor it), the system font at 14px.
- **Delivery events.** The component owns a Queue (`ember-<project>-<env>-email-events`). Point an Email Service
  event subscription for your sending domain at it. Events are deduplicated by `eventId`, the status only moves
  forward, and `lib:get` is reactive.
- **Inbound.** The component hooks the Worker's `email()` handler:
  - It routes mailbox addresses (`support@`, `privacy@`) and plus-addressed thread tokens. Unknown addresses are
    rejected.
  - It stores the raw `.eml` and the attachments in files (R2), and parses the message with `postal-mime`.
  - It reads DKIM, DMARC and SPF from Cloudflare's `Authentication-Results`.
  - It threads messages like a mail client, with no token in the Reply-To by default:
    - an answer that cites an email the mailbox sent joins its thread when the sender is the thread's contact or one
      of that email's recipients (In-Reply-To / References against the Message-ID the provider gave it, recorded when
      the send succeeds; DMARC not required, since only those recipients have that id);
    - a citation of an inbound message counts with DMARC pass from the contact;
    - then the same contact and subject, within 30 days, if the thread is not closed or spam;
    - a plus-addressed token (`support+t_…@`) still threads from any sender.
  - `replyToken: true` in the install config puts that token in the Reply-To of replies, composed emails and
    auto-replies, as before 0.5.4.
  - Replies and auto-replies cite the Message-ID and References exactly as the sender wrote them (Gmail only groups a
    reply in the conversation on an exact match); lookups ignore case.
  - It handles spam per sender per hour and auto-replies without loops.
  - Your `onInbound` hook runs in the same transaction (tickets, push).
- **Inbox queries** for dashboards and mobile apps: `threads`, `thread`, `unread` (aggregate), `search`
  (`searchIndex`), `reply`, `note`, `markRead`, `markUnread`, `setStatus`, `deleteThread` (the conversation and its messages, now), `assign`, `compose` (a new conversation
  from the mailbox, answers join it as above), `recent` (latest threads with their messages, for offline replicas) and
  `sent` (the mailbox's Sent view: threads it wrote in, by its latest send, paged with `before`).
  `reply` and `compose` build the email like a mail client:
  - `text` (required) is the text/plain part, and the HTML part when nothing richer is given (paragraphs, with
    `http(s)://` and `mailto:` URLs linked).
  - `bodyHtml?: string` is the composer's rich body, an HTML fragment. It is sanitized to `p br div span b strong i em
    u s a ul ol li blockquote code pre`, no attributes but `a[href]` (`http:`, `https:`, `mailto:`); script, style,
    iframe and the like go with their content, other tags leave their text (`sanitizeEmailHtml`). It is kept on the
    thread's message as `html`. `html?: string` (a whole document, used as is) still works; not both.
  - `signature?: { text: string; html?: string }`: after the body, `-- ` + `text` in the text part, Gmail's
    `gmail_signature` block in the HTML part (`html` sanitized the same way, or `text` rendered).
  - `reply` quotes the last inbound message (its first 40 lines) under Gmail's `gmail_quote` structure, which Gmail
    and Apple Mail collapse, and `> ` lines in the text part. `quoteHeader?: string` is the attribution line, already
    localized (`Em 5 de nov. de 2026, Marina Costa escreveu:`); the default is `On {date}, {name} <{email}> wrote:`.
  `reply` and `compose` take `bcc?: string[]` (blind copies, validated and counted like `cc`). Those addresses go to
  the provider as Bcc, in the envelope only, never in a header or body the recipients see. They are stored on the
  thread's outbound message (`bcc`) for the mailbox's own view, and an answer from one of them joins the thread.
  `reply` and `compose` take `attachments: [{ filename, contentType, file }]`, files already stored in the shard
  (uploaded with `ctx.storage.generateUploadUrl`). They go with the email and stay on the thread's outbound message
  (with their size). Mind the provider's message size: for a large file, put a download link in the text
  (`ctx.storage.getUrl(file, { download, expiresIn })`) and pass it with `link: true`. The email then has no MIME part
  for it, and the message still holds the file (the thread lists it, and it is not collected).
- **Lists and counts** (exact, index-backed):
  - `threads({ mailbox, status?, assignee?, unread?, tag?, paginationOpts? })`, newest message first.
    `assignee` is an app user id, or `null` for unassigned. `unread: true` lists threads with unread messages,
    `false` the others. `tag` is a tag id. Each filter has an index (with or without `status`). When you combine
    filters, the most selective one picks the index and the others filter its range, so the page is still exact.
  - Each thread stores `hasUnread` (`unreadCount > 0`). Every path that changes `unreadCount` writes it: inbound,
    `markRead`, `markUnread`. Offline replicas can filter on it.
  - `counts({ mailbox, assignee? })` returns `{ all, byStatus, assignee?, tags }`. Each block is `{ threads, unread,
    unreadThreads }` (`unread` counts messages). They come from aggregates that the writes keep up to date, so a call
    reads a few group rows and never scans threads.
- **Tags (labels)**, per mailbox:
  - `tags({ mailbox })` lists them in order. `createTag({ mailbox, name, color?, order? })`: names are unique per
    mailbox, ignoring case, 1..40 characters. `color` is one of `TAG_COLORS` (`gray` by default), at most 100 tags
    per mailbox. Also `updateTag({ tagId, name?, color?, order? })` and `deleteTag({ tagId })`.
  - Threads hold tag ids in `tags` (at most 20). Change them with `setTags({ threadId, tags, author? })`,
    `addTag({ threadId, tag, author? })` and `removeTag(...)`; each returns the tags as written.
  - `deleteTag` takes the tag off every thread: 200 threads in its own transaction, the rest in `lib:untag` jobs.
  - A `threadTags` row per (thread, tag) backs the `tag` filter and the per-tag counts. The component keeps those
    rows in step with the thread.
- **Activity timeline:** `activity({ threadId, limit? })`, oldest first. The component writes it, with the `author`
  arg as the actor (`setStatus`, `assign`, `setTags`, `addTag`, `removeTag` and `reply` take one; absent means
  the system). Kinds:
  - `status` `{ from, to }`, including the automatic changes (an answer reopens a thread, a reply makes it
    `waiting`);
  - `assigned` `{ from, fromName?, to, toName? }`;
  - `tag_added` / `tag_removed` `{ tag, name, color }`;
  - `delivery` `{ emailId, status, previous, messageId?, recipient?, … }`, for the thread's outbound emails reaching
    `sent`, `delivery_delayed`, `delivered`, `bounced`, `complained`, `failed`, `suppressed` or `canceled`.

  Messages and notes are not repeated in the timeline: clients merge them by time.
- **Upgrading from 0.6:** older threads have no `hasUnread`. The `lib:maintain` cron (every 10 minutes, bounded
  batches) fills it in once the new indexes have backfilled. Until then those threads are missing from
  `unread: true` and from `unreadThreads`; the other counts and lists are right.
- **Retention:** `upsertMailbox({ retention: { closedDays: 730, spamDays: 30 } })` keeps closed and spam conversations
  that many days, counted from the latest status change or message; a daily job (`lib:purge`, 04:00
  UTC) then deletes the conversation and its messages, and file GC deletes their `.eml` and attachments. Without
  `retention` (or with `retention: null`) nothing is deleted.

## Domains: `@freecorps/ember-email/cloudflare`

Puts a domain on Cloudflare for the component and removes it again. It only needs `fetch`, so it runs in a Worker
(with its own API token secret) or on an operator's machine (no token in the Worker). It has no storage, HTTP API
or keys: you keep the returned state.

```ts
import { destroyDomain, emailResources, resolveAccountId, syncDomain } from "@freecorps/ember-email/cloudflare";

const c = { apiToken, accountId: await resolveAccountId(apiToken, { env: process.env }) };
const { worker, eventsQueue } = emailResources("acme", "prod"); // ember-acme-prod, ember-acme-prod-email-events
let d = await syncDomain(c, { name: "mail.acme.com", enableRouting: true }, { prev: null, mailboxes: ["support@mail.acme.com"], worker, queue: eventsQueue });
// d.status: "pending" until Email Service finishes onboarding (a minute or two): sync again with { prev: d }.
// d.records: the DNS records involved; d.notes: what is missing or needs the zone owner.
await destroyDomain(c, d); // rules, event subscription, and the sending domain if this created it
```

What it does:

- **Sending:** it onboards the domain in Email Service. Cloudflare manages its records (bounce MX/SPF, DKIM, DMARC).
- **Receiving:** it checks Email Routing. For the zone apex, routing must already be on, because turning it on
  rewrites the zone's MX. For a subdomain, `enableRouting: true` creates the routing subdomain. No API removes a
  routing subdomain, so removal is a dashboard step.
- **Mailboxes:** it adds one literal rule per mailbox address on the domain → your Worker. It never changes a rule
  that routes somewhere else.
- **Catch-all:** with `catchAll: true` (a mailbox of the domain is its catch-all, `upsertMailbox({ catchAll: true })`),
  the zone's catch-all rule → your Worker, so every address no mailbox has reaches that mailbox, with the address it
  was sent to in its To. Only for the zone apex, since the rule belongs to the zone. It never takes over a catch-all
  that routes somewhere else. `destroyDomain`, or a sync without `catchAll`, turns it back off.
- **Events:** it adds an `email.sending` event subscription → the component's queue.

## Offline replicas: `@freecorps/ember-email/schema`

`emailSchema`: the component's tables only (no postal-mime), for clients composing a local replica schema, and `TAG_COLORS`.

## Example

[`examples/email-lite`](https://github.com/freecorps/ember/tree/main/examples/email-lite) is the smallest app on the
component (mailboxes, send, inbound). [freecorps/mail](https://github.com/freecorps/mail) is a full email service
built on it (Resend-style HTTP API, inbox, mobile app).

All the component's state lives in one shard (`config.shard`, default `global:main`).

See `docs/PLAN.md` §16 and `docs/design/contracts.md` ("Email") in the repository.

License: MIT.
