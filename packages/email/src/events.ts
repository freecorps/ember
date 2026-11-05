// Delivery events of Email Service (docs 2026-10, "event subscriptions"): a Queues event subscription with source
// `email.sending` delivers `cf.email.sending.message.{delivered,deferred,bounced,failed,rejected,complained}`:
//   { type, source: { type: "email.sending", zoneId, domain },
//     payload: { eventId, messageId, sender, recipient, subject?, terminal, delivery?, bounce?, failure?, rejection?, complaint? },
//     metadata: { accountId, eventSubscriptionId, eventSchemaVersion, eventTimestamp } }
// No ordering or exactly-once guarantee is documented (R11 measures it): events are deduplicated by eventId and an
// email's status only moves forward (see `nextStatus`).

export type EventType = "delivered" | "deferred" | "bounced" | "failed" | "rejected" | "complained";

export interface DeliveryEvent {
  eventId: string;
  type: EventType;
  /** Provider message id (what `send` returned). */
  messageId: string;
  recipient: string | null;
  sender: string | null;
  terminal: boolean;
  /** When the platform says it happened (ms). */
  at: number;
  bounceType?: "soft" | "hard";
  reason?: string;
  smtpStatus?: string;
  /** The payload as received (stored with the event). */
  raw: unknown;
}

const TYPES: Record<string, EventType> = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.complained": "complained",
};

const s = (x: unknown) => (typeof x === "string" && x ? x : null);

/** A Queue message body → a DeliveryEvent, or null when it is not an Email Service event. */
export function parseDeliveryEvent(body: unknown): DeliveryEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, any>;
  const type = TYPES[String(b.type)] ?? (typeof b.type === "string" && b.type.startsWith("cf.email.sending.message.") ? null : null);
  if (!type) return null;
  const p = (b.payload ?? {}) as Record<string, any>;
  const messageId = s(p.messageId) ?? s(p.message_id);
  if (!messageId) return null;
  const ts = b.metadata?.eventTimestamp ?? p.timestamp;
  const at = typeof ts === "number" ? (ts < 1e12 ? ts * 1000 : ts) : typeof ts === "string" ? Date.parse(ts) : NaN;
  const reason = s(p.bounce?.reason) ?? s(p.failure?.reason) ?? s(p.rejection?.reason) ?? s(p.complaint?.type) ?? s(p.delivery?.smtpResponse) ?? undefined;
  const smtp = s(p.delivery?.smtpEnhancedStatusCode) ?? (p.delivery?.smtpStatusCode !== undefined ? String(p.delivery.smtpStatusCode) : null);
  const bounceType = p.bounce?.type === "hard" || p.bounce?.type === "soft" ? (p.bounce.type as "hard" | "soft") : undefined;
  return {
    eventId: s(p.eventId) ?? s(p.event_id) ?? `${messageId}:${type}:${s(p.recipient) ?? ""}:${Number.isFinite(at) ? at : ""}`,
    type,
    messageId,
    recipient: s(p.recipient)?.toLowerCase() ?? null,
    sender: s(p.sender)?.toLowerCase() ?? null,
    terminal: typeof p.terminal === "boolean" ? p.terminal : type !== "deferred",
    at: Number.isFinite(at) ? at : Date.now(),
    ...(bounceType ? { bounceType } : {}),
    ...(reason ? { reason: reason.slice(0, 500) } : {}),
    ...(smtp ? { smtpStatus: smtp } : {}),
    raw: body,
  };
}

/** Lifecycle of an outbound email. */
export type EmailStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "delivery_delayed"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "canceled"
  | "suppressed";

const RANK: Record<EmailStatus, number> = {
  scheduled: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivery_delayed: 4,
  delivered: 5,
  bounced: 6,
  failed: 6,
  complained: 7,
  canceled: 8,
  suppressed: 8,
};

const EVENT_STATUS: Record<EventType, EmailStatus> = {
  delivered: "delivered",
  deferred: "delivery_delayed",
  bounced: "bounced",
  failed: "failed",
  rejected: "failed",
  complained: "complained",
};

/**
 * Status after an event (per email, across its recipients): moves forward only, so a late `deferred` after
 * `delivered` (out of order) changes nothing; a complaint after delivery wins.
 */
export function nextStatus(current: EmailStatus, ev: EventType): EmailStatus {
  const to = EVENT_STATUS[ev];
  return RANK[to] > RANK[current] ? to : current;
}
