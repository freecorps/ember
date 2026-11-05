/**
 * Provider-neutral push types. Two transports implement them: Expo Push (`expo.ts`, zero setup) and direct APNs (ES256
 * provider token over HTTP/2, `apns.ts`) + FCM HTTP v1 (service-account OAuth, `fcm.ts`). Callers do not change.
 */
import type { PushEnvelope } from "./envelope.ts";

/**
 * How urgent a push is. Direct transports map it to the APNs priority, the FCM Android priority, the TTL default and
 * the iOS interruption level (Brigade's `low`/`high`/`page`, see `delivery.ts`):
 *
 * | urgency  | APNs priority | FCM priority | TTL default | interruption level |
 * |----------|---------------|--------------|-------------|--------------------|
 * | `low`    | 5             | NORMAL       | 4 h         | active             |
 * | `normal` | 10            | HIGH         | 1 h         | active             |
 * | `high`   | 10            | HIGH         | 15 min      | time-sensitive     |
 */
export type PushUrgency = "low" | "normal" | "high";

/** iOS 15+ interruption levels. `time-sensitive` needs the entitlement; `critical` needs Apple's approval. */
export type PushInterruptionLevel = "passive" | "active" | "time-sensitive" | "critical";

/** APNs environment of an iOS device token: Xcode/development-signed builds get sandbox tokens, ad hoc/TestFlight/App Store ones production. */
export type ApnsEnvironment = "sandbox" | "production";

/**
 * End-to-end encryption of a push (direct transport only):
 * - `off`: content in clear;
 * - `auto` (default): sealed for devices that registered a public key, in clear for the others;
 * - `required`: sealed; a device without a key (or an Expo token) gets only the fallback text.
 */
export type PushEncryption = "off" | "auto" | "required";

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
  /** Direct transports: see `PushUrgency`. Without it, `priority: "normal"` means `low`, anything else `normal`. */
  urgency?: PushUrgency;
  /** Replaces an earlier notification with the same id (APNs `apns-collapse-id`, ≤ 64 bytes; FCM `collapse_key` + tag; Expo `collapseId` + `tag`). */
  collapseId?: string;
  /** iOS notification grouping (`thread-id`). */
  threadId?: string;
  /** iOS interruption level; default from `urgency` (`high` → `time-sensitive`). */
  interruptionLevel?: PushInterruptionLevel;
  /** Direct transports: overrides the install's encryption setting for this message (see `PushEncryption`). */
  encryption?: PushEncryption;
  /**
   * iOS: send as a PushKit VoIP push to the device's `voipToken` (topic `<bundle id>.voip`, push type `voip`). The app
   * must report a call to CallKit for every one, or iOS stops delivering them. Devices without a VoIP token are skipped.
   */
  voip?: boolean;
}

/** A message for one device token. */
export interface AddressedPushMessage extends PushMessage {
  to: string;
  /** APNs environment of `to` (iOS). Unknown: the transport's default, then the other host if APNs says `BadDeviceToken`. */
  environment?: ApnsEnvironment;
  /**
   * Set by `sendToDevices` when the content is sealed for this device: the transport sends this envelope and the
   * fallback text instead of title/subtitle/body/data.
   */
  sealed?: PushEnvelope;
}

/** What a device shows when an encrypted push cannot be opened (or, with `encryption: "required"`, has no key). */
export interface PushFallback {
  title?: string;
  body?: string;
  /** iOS: localization keys from the app's `Localizable.strings`, preferred over the plain text when set. */
  titleLocKey?: string;
  locKey?: string;
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
  /** `environment`: set when a direct send found the device's APNs environment by trying the other host. */
  | { token: string; status: "ok"; id: string; environment?: ApnsEnvironment }
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
