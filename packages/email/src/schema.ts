// Tables of the email component (installed as `email`: physical `email$<table>` in the component's shard).

import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export const addressV = v.object({ email: v.string(), name: v.optional(v.string()) });

export const attachmentV = v.object({
  filename: v.string(),
  contentType: v.string(),
  file: v.file(),
  size: v.optional(v.number()),
  contentId: v.optional(v.string()),
  inline: v.optional(v.boolean()),
  /** Sent as a link in the body (too large to attach), not as a MIME part: the message still holds the file. */
  link: v.optional(v.boolean()),
});

export const errorV = v.object({ code: v.string(), message: v.string() });

export const emailSchema = defineSchema({
  tables: {
    /** Outbound emails (what `send` created) and their delivery state. */
    emails: defineTable({
      project: v.string(),
      from: addressV,
      to: v.array(addressV),
      cc: v.optional(v.array(addressV)),
      bcc: v.optional(v.array(addressV)),
      replyTo: v.optional(addressV),
      subject: v.string(),
      html: v.optional(v.string()),
      text: v.optional(v.string()),
      headers: v.optional(v.record(v.string())),
      attachments: v.optional(v.array(attachmentV)),
      template: v.optional(v.object({ name: v.string(), data: v.any() })),
      tags: v.optional(v.record(v.string())),
      idempotencyKey: v.optional(v.string()),
      status: v.string(),
      sendAt: v.number(),
      attempts: v.number(),
      claimedAt: v.optional(v.number()),
      jobId: v.optional(v.string()),
      /** Provider message id (Email Service): delivery events refer to it. */
      messageId: v.optional(v.string()),
      sentAt: v.optional(v.number()),
      lastEventAt: v.optional(v.number()),
      error: v.optional(errorV),
      /** Recipients dropped because they are suppressed. */
      suppressed: v.optional(v.array(v.string())),
      /** Headers the provider refused and that were dropped on a retry. */
      droppedHeaders: v.optional(v.array(v.string())),
      threadId: v.optional(v.string()),
    })
      .index("by_project_key", ["project", "idempotencyKey"])
      .index("by_message_id", ["messageId"])
      .index("by_status", ["status", "sendAt"])
      .index("by_project", ["project"])
      .aggregate("by_project_status", { by: ["project", "status"], count: true }),

    /** Delivery events from the Email Service queue (deduplicated by eventId). */
    events: defineTable({
      eventId: v.string(),
      emailId: v.optional(v.id("emails")),
      messageId: v.string(),
      type: v.string(),
      recipient: v.optional(v.string()),
      terminal: v.boolean(),
      /** When the platform says it happened / when the shard stored it (R11: queue latency). */
      at: v.number(),
      receivedAt: v.number(),
      reason: v.optional(v.string()),
      bounceType: v.optional(v.string()),
      smtpStatus: v.optional(v.string()),
      /** Redeliveries of the same eventId (queues are at-least-once; R11). */
      duplicates: v.optional(v.number()),
      raw: v.any(),
    })
      .index("by_event", ["eventId"])
      .index("by_email", ["emailId"])
      .index("by_message", ["messageId"]),

    /** Addresses that must not be sent to, per project (hard bounces, complaints, manual). */
    suppressions: defineTable({ project: v.string(), email: v.string(), reason: v.string(), source: v.optional(v.string()), at: v.number() }).index("by_project_email", [
      "project",
      "email",
    ]),

    /** Stored templates (`{{var}}` engine, see template.ts). */
    templates: defineTable({
      project: v.string(),
      name: v.string(),
      subject: v.string(),
      html: v.string(),
      text: v.optional(v.string()),
      layout: v.optional(v.any()),
      updatedAt: v.number(),
    }).index("by_project_name", ["project", "name"]),

    /** Inbound addresses (support@, privacy@) and their settings. */
    mailboxes: defineTable({
      name: v.string(),
      address: v.string(),
      displayName: v.optional(v.string()),
      autoReply: v.optional(v.object({ subject: v.string(), text: v.string(), html: v.optional(v.string()) })),
      /** Receives mail for any address of its domain that no other mailbox has (one per domain). */
      catchAll: v.optional(v.boolean()),
      /**
       * How long closed and spam conversations are kept, in days, counted from the later of the status change and the
       * last message. Absent: kept forever. A daily job deletes the conversation, its messages and their files.
       */
      retention: v.optional(v.object({ closedDays: v.optional(v.number()), spamDays: v.optional(v.number()) })),
      nextNumber: v.number(),
      createdAt: v.number(),
    })
      .index("by_address", ["address"])
      .index("by_name", ["name"]),

    /** Conversations (tickets) of a mailbox. */
    threads: defineTable({
      mailbox: v.string(),
      number: v.number(),
      subject: v.string(),
      subjectKey: v.string(),
      contact: v.string(),
      contactName: v.optional(v.string()),
      /** open | waiting | closed | spam */
      status: v.string(),
      /** When `status` last changed (absent on threads from before it was recorded: `lastMessageAt` stands in). */
      statusAt: v.optional(v.number()),
      /** Plus-address token: replies to `support+t_<token>@` join this thread from any sender. */
      token: v.string(),
      messageCount: v.number(),
      unreadCount: v.number(),
      lastMessageAt: v.number(),
      lastInboundAt: v.optional(v.number()),
      snippet: v.string(),
      /** The member handling the thread (app user id) and the name shown for them. */
      assignee: v.optional(v.string()),
      assigneeName: v.optional(v.string()),
    })
      .index("by_mailbox_last", ["mailbox", "lastMessageAt"])
      .index("by_mailbox_status", ["mailbox", "status", "lastMessageAt"])
      .index("by_token", ["token"])
      .index("by_contact_subject", ["mailbox", "contact", "subjectKey"])
      .aggregate("unread", { by: ["mailbox"], count: true, sum: ["unreadCount"] }),

    /** Messages of a thread: inbound mail, replies sent from the inbox, internal notes. */
    messages: defineTable({
      threadId: v.id("threads"),
      mailbox: v.string(),
      /** inbound | outbound | note */
      direction: v.string(),
      messageIdHeader: v.optional(v.string()),
      inReplyTo: v.optional(v.string()),
      references: v.array(v.string()),
      from: addressV,
      fromEmail: v.string(),
      to: v.array(addressV),
      cc: v.array(addressV),
      subject: v.string(),
      text: v.string(),
      html: v.optional(v.string()),
      snippet: v.string(),
      /** subject + sender + text: the search index field. */
      searchText: v.string(),
      truncated: v.optional(v.boolean()),
      raw: v.optional(v.file()),
      attachments: v.array(attachmentV),
      droppedAttachments: v.optional(v.number()),
      auth: v.optional(v.object({ spf: v.string(), dkim: v.string(), dmarc: v.string() })),
      autoSubmitted: v.boolean(),
      emailId: v.optional(v.id("emails")),
      author: v.optional(v.string()),
      at: v.number(),
    })
      .index("by_thread", ["threadId", "at"])
      .index("by_message_id", ["mailbox", "messageIdHeader"])
      .index("by_sender", ["mailbox", "fromEmail", "at"])
      .searchIndex("search", { searchField: "searchText", filterFields: ["mailbox", "direction"] }),
  },
});
