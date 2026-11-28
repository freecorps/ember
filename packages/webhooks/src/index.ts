/**
 * `@freecorps/ember-webhooks`: outbound webhooks as an Ember component (PLAN §12): Standard Webhooks signatures,
 * retries with backoff and jitter, a circuit breaker per endpoint, a dead-letter state and replays. The HTTP calls are
 * actions run by a nested `@freecorps/ember-workpool` (bounded parallelism per shard).
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(webhooks);
 *
 *   // ember/billing.ts
 *   const hooks = new Webhooks(components.webhooks);
 *   export const pay = mutation({ args: { invoiceId: v.id("invoices") }, handler: (ctx, a) => {
 *     ctx.db.patch(a.invoiceId, { paid: true });
 *     hooks.send(ctx, "invoice.paid", { invoiceId: a.invoiceId });   // same transaction: no paid invoice without its webhook
 *   }});
 *
 *   // a receiver (any runtime with WebCrypto): `@freecorps/ember-webhooks/verify`
 *   const event = await verifyWebhook(secret, request.headers, await request.text());
 *
 * Endpoints and deliveries live in the caller's shard: an org shard holds its org's endpoints.
 */
import type { ErrorSpec, FunctionReference, PaginationOptions, PaginationResult } from "@freecorps/ember-server";
import type { DeliveryStatus } from "./component.ts";
import type { Breaker } from "./policy.ts";

export * from "./verify.ts";
export * from "./policy.ts";
export {
  webhooks,
  functions as webhooksFunctions,
  webhookErrors,
  installConfigValidator,
  BATCH,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_OFFLOAD_BYTES,
  DEFAULT_RETENTION_MS,
  DEFAULT_ROTATION_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  type AttemptReport,
  type DeliveryStatus,
  type WebhooksInstallConfig,
} from "./component.ts";

/** An endpoint as the component's queries return it (secrets never leave the component). */
export interface WebhookEndpoint {
  _id: string;
  url: string;
  events: string[];
  description?: string;
  enabled: boolean;
  breaker: Breaker;
  /** Secrets signing now (2 during a rotation's grace period). */
  signingSecrets: number;
  metadata?: unknown;
  createdAt: number;
}

export interface DeliveryAttempt {
  at: number;
  attempt: number;
  event: "delivered" | "retry" | "dead" | "held" | "replay" | "probe";
  status?: number;
  error?: string;
  durationMs?: number;
}

export interface WebhookDelivery {
  _id: string;
  _creationTime: number;
  endpointId: string;
  messageId: string;
  event: string;
  status: DeliveryStatus;
  attempt: number;
  heldAt?: number;
  nextAt?: number;
  lastError?: string;
  responseStatus?: number;
  responseBody?: string;
  durationMs?: number;
  history: DeliveryAttempt[];
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

type EndpointNotFound = ErrorSpec<"EndpointNotFound", { endpointId: string }>;
type DeliveryNotFound = ErrorSpec<"DeliveryNotFound", { deliveryId: string }>;
type PayloadTooLarge = ErrorSpec<"PayloadTooLarge", { size: number; max: number }>;
type EndpointArgs = { url: string; events?: string[]; description?: string; metadata?: unknown };
type SendResult = { messageId: string | null; deliveries: string[] };

/** What `components.<name>` of the webhooks component looks like (structural: any install name works). */
export interface WebhooksComponentApi {
  lib: {
    send: FunctionReference<"mutation", "public", { event: string; payload: unknown; endpointIds?: string[] }, SendResult, PayloadTooLarge>;
    createEndpoint: FunctionReference<"mutation", "public", EndpointArgs, { endpointId: string; secret: string }>;
    updateEndpoint: FunctionReference<"mutation", "public", { endpointId: string } & Partial<EndpointArgs>, null, EndpointNotFound>;
    setEnabled: FunctionReference<"mutation", "public", { endpointId: string; enabled: boolean }, null, EndpointNotFound>;
    rotateSecret: FunctionReference<"mutation", "public", { endpointId: string; graceMs?: number }, { secret: string; previousExpiresAt: number }, EndpointNotFound>;
    deleteEndpoint: FunctionReference<"mutation", "public", { endpointId: string }, boolean>;
    replay: FunctionReference<"mutation", "public", { deliveryId: string }, null, DeliveryNotFound | EndpointNotFound>;
    replayDead: FunctionReference<"mutation", "public", { endpointId: string }, number, EndpointNotFound>;
    getEndpoint: FunctionReference<"query", "public", { endpointId: string }, unknown>;
    listEndpoints: FunctionReference<"query", "public", Record<string, never>, unknown>;
    getDelivery: FunctionReference<"query", "public", { deliveryId: string }, unknown>;
    listDeliveries: FunctionReference<"query", "public", { status?: DeliveryStatus; endpointId?: string; paginationOpts: PaginationOptions }, unknown>;
  };
}

// Method syntax: any ctx's typed `runQuery`/`runMutation` fits (parameters are compared bivariantly).
type SyncReadCtx = { db: unknown; runQuery(fn: unknown, args?: unknown): unknown };
type SyncWriteCtx = SyncReadCtx & { runMutation(fn: unknown, args?: unknown): unknown };
type AsyncCtx = { runQuery(fn: unknown, args?: unknown): Promise<unknown>; runMutation(fn: unknown, args?: unknown): Promise<unknown> };
type R<Sync, T> = Sync extends AsyncCtx ? Promise<T> : T;

const isSync = (ctx: SyncReadCtx | AsyncCtx): ctx is SyncReadCtx => "db" in ctx;

/**
 * Typed helper over an installed webhooks component. In a mutation every call is synchronous and part of its
 * transaction (`send` commits with the app's own writes); in an action each call is its own transaction (a Promise).
 */
export class Webhooks {
  constructor(readonly component: WebhooksComponentApi) {}

  /** Queues `event` for every enabled endpoint subscribed to it (see `lib:send`). */
  send<X extends SyncWriteCtx | AsyncCtx>(ctx: X, event: string, payload: unknown, opts: { endpointIds?: string[] } = {}): R<X, SendResult> {
    return this.write(ctx).runMutation(this.component.lib.send, { event, payload, ...(opts.endpointIds ? { endpointIds: opts.endpointIds } : {}) }) as R<X, SendResult>;
  }
  /** Adds an endpoint; returns its id and its secret (shown once: give it to the receiver). */
  createEndpoint<X extends SyncWriteCtx | AsyncCtx>(ctx: X, endpoint: EndpointArgs): R<X, { endpointId: string; secret: string }> {
    return this.write(ctx).runMutation(this.component.lib.createEndpoint, endpoint) as R<X, { endpointId: string; secret: string }>;
  }
  updateEndpoint<X extends SyncWriteCtx | AsyncCtx>(ctx: X, endpointId: string, changes: Partial<EndpointArgs>): R<X, null> {
    return this.write(ctx).runMutation(this.component.lib.updateEndpoint, { endpointId, ...changes }) as R<X, null>;
  }
  setEnabled<X extends SyncWriteCtx | AsyncCtx>(ctx: X, endpointId: string, enabled: boolean): R<X, null> {
    return this.write(ctx).runMutation(this.component.lib.setEnabled, { endpointId, enabled }) as R<X, null>;
  }
  /** A new secret signs from now on, the previous one for `graceMs` more (default 24 h). */
  rotateSecret<X extends SyncWriteCtx | AsyncCtx>(ctx: X, endpointId: string, opts: { graceMs?: number } = {}): R<X, { secret: string; previousExpiresAt: number }> {
    return this.write(ctx).runMutation(this.component.lib.rotateSecret, { endpointId, ...opts }) as R<X, { secret: string; previousExpiresAt: number }>;
  }
  deleteEndpoint<X extends SyncWriteCtx | AsyncCtx>(ctx: X, endpointId: string): R<X, boolean> {
    return this.write(ctx).runMutation(this.component.lib.deleteEndpoint, { endpointId }) as R<X, boolean>;
  }
  /** Sends a dead, failed or delivered delivery again (same message id). */
  replay<X extends SyncWriteCtx | AsyncCtx>(ctx: X, deliveryId: string): R<X, null> {
    return this.write(ctx).runMutation(this.component.lib.replay, { deliveryId }) as R<X, null>;
  }
  /** Replays every dead delivery of an endpoint. */
  replayDead<X extends SyncWriteCtx | AsyncCtx>(ctx: X, endpointId: string): R<X, number> {
    return this.write(ctx).runMutation(this.component.lib.replayDead, { endpointId }) as R<X, number>;
  }
  endpoint<X extends SyncReadCtx | AsyncCtx>(ctx: X, endpointId: string): R<X, WebhookEndpoint | null> {
    return ctx.runQuery(this.component.lib.getEndpoint, { endpointId }) as R<X, WebhookEndpoint | null>;
  }
  endpoints<X extends SyncReadCtx | AsyncCtx>(ctx: X): R<X, WebhookEndpoint[]> {
    return ctx.runQuery(this.component.lib.listEndpoints, {}) as R<X, WebhookEndpoint[]>;
  }
  delivery<X extends SyncReadCtx | AsyncCtx>(ctx: X, deliveryId: string): R<X, WebhookDelivery | null> {
    return ctx.runQuery(this.component.lib.getDelivery, { deliveryId }) as R<X, WebhookDelivery | null>;
  }
  /** Deliveries newest first: all, by status, or of one endpoint. */
  deliveries<X extends SyncReadCtx | AsyncCtx>(ctx: X, opts: { status?: DeliveryStatus; endpointId?: string; paginationOpts: PaginationOptions }): R<X, PaginationResult<WebhookDelivery>> {
    return ctx.runQuery(this.component.lib.listDeliveries, opts) as R<X, PaginationResult<WebhookDelivery>>;
  }

  private write<X extends SyncWriteCtx | AsyncCtx>(ctx: X): SyncWriteCtx | AsyncCtx {
    if (isSync(ctx) && typeof (ctx as Partial<SyncWriteCtx>).runMutation !== "function") throw new Error("webhooks: needs a mutation or action ctx");
    return ctx;
  }
}
