/**
 * Provider-neutral push types. Expo Push is the first provider (PLAN §10, CLOUDFLARE.md §8); direct APNs (ES256 JWT
 * over HTTP/2) and FCM v1 (service-account OAuth) can implement `PushProvider` later without changing callers.
 */

/** What a notification says. Fields a provider does not support are ignored by it. */
export interface PushMessage {
  title?: string;
  subtitle?: string;
  body?: string;
  /** Delivered to the app (JSON object). Counts toward the 4 KiB payload limit. */
  data?: Record<string, unknown>;
  /** `"default"` plays the default sound (iOS). */
  sound?: "default" | null;
  /** iOS app icon badge; 0 clears it. */
  badge?: number;
  /** Android notification channel (created by the app, e.g. `registerForPush` creates `"default"`). */
  channelId?: string;
  priority?: "default" | "normal" | "high";
  /** Seconds the push service keeps trying to deliver. */
  ttl?: number;
  /** iOS background ("silent") push: data-only + `content-available`. Apple advises at most 2–3 per hour. */
  contentAvailable?: boolean;
  /** iOS notification category (actions). */
  categoryId?: string;
  /** iOS Notification Service Extension may modify the content. */
  mutableContent?: boolean;
}

/** A message for one device token. */
export interface AddressedPushMessage extends PushMessage {
  to: string;
}

/** Well-known per-message errors (Expo names; APNs/FCM providers map theirs onto these). */
export type PushErrorCode =
  | "DeviceNotRegistered"
  | "MessageTooBig"
  | "MessageRateExceeded"
  | "MismatchSenderId"
  | "InvalidCredentials"
  | "InvalidToken"
  | "RequestFailed"
  | (string & {});

/** The push service's answer at send time. `ok` means accepted, not delivered: check receipts later. */
export type PushTicket =
  | { token: string; status: "ok"; id: string }
  | { token: string; status: "error"; message: string; error?: PushErrorCode };

/** Final delivery outcome reported by the provider (Expo keeps receipts for 24 h). */
export type PushReceipt =
  | { token: string; id: string; status: "ok" }
  | { token: string; id: string; status: "error"; message: string; error?: PushErrorCode };

export interface ReceiptCheck {
  receipts: PushReceipt[];
  /** Ticket ids with no receipt yet (try again later; Expo usually has them within 15 min). */
  pending: Array<{ token: string; id: string }>;
  /** Tokens to delete from the device table (DeviceNotRegistered in a ticket or a receipt). */
  unregisteredTokens: string[];
}

export interface SendPushResult {
  tickets: PushTicket[];
  /** Tokens to delete right away: malformed, or DeviceNotRegistered in the ticket. */
  unregisteredTokens: string[];
}

/** A push backend. `send` never throws for per-message failures: they come back as error tickets. */
export interface PushProvider {
  readonly name: string;
  /** Whether `token` looks like a token of this provider (cheap format check). */
  isToken(token: string): boolean;
  send(messages: AddressedPushMessage[]): Promise<PushTicket[]>;
  /** Providers without receipts (APNs/FCM answer synchronously) may omit this. */
  checkReceipts?(tickets: PushTicket[]): Promise<ReceiptCheck>;
}
