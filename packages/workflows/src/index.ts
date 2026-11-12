/**
 * `@freecorps/ember-workflows`: durable multi-step functions as an Ember component (PLAN §8, §12), on the shard
 * scheduler (see contracts.md for why not Cloudflare Workflows).
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(workflows);
 *
 *   // ember/onboarding.ts
 *   export const workflow = new WorkflowManager(components.workflows);
 *   export const onboard = workflow.define({
 *     args: { domain: v.string() },
 *     handler: async (step, { domain }) => {
 *       const zone = await step.runAction(internal.domains.createZone, { domain }, { retry: { maxAttempts: 5 } });
 *       await step.sleep(10 * MINUTE);
 *       const dns = await step.waitForEvent<{ ok: boolean }>("dns-verified", { timeoutMs: DAY });
 *       await step.runMutation(internal.domains.activate, { zone, ok: dns.ok });
 *       return zone;
 *     },
 *   });
 *
 *   // in a mutation (atomic with it): const id = workflow.start(ctx, internal.onboarding.onboard, { domain });
 *   // later: workflow.sendEvent(ctx, id, "dns-verified", { ok: true }); workflow.status(ctx, id) (reactive)
 */
import { createFunctionHandle, internalActionGeneric, v, type FunctionReference, type RegisteredAction } from "@freecorps/ember-server";
import type { ArgsType, ArgsValidator } from "@freecorps/ember-server";
import { replay, type JournalEntry, type Outcome, type RetryPolicy, type WorkflowStep } from "./replay.ts";
import type { WorkflowStatus } from "./component.ts";

export { workflows, functions as workflowFunctions, type WorkflowsInstallConfig, type WorkflowStatus } from "./component.ts";
export { replay, handleOf, StepFailed, NonDeterminism, type WorkflowStep, type StepOptions, type StepRequest, type JournalEntry, type Outcome, type RetryPolicy } from "./replay.ts";

type Ref<T extends "query" | "mutation", A, R> = FunctionReference<T, "public", A, R>;

/** What `components.<name>` of the workflows component looks like (structural: any install name works). */
export interface WorkflowsComponentApi {
  lib: {
    start: Ref<"mutation", { driver: string; args?: any; onComplete?: string; context?: any }, string>;
    status: Ref<"query", { id: string }, WorkflowStatus | null>;
    steps: Ref<"query", { id: string }, any[]>;
    sendEvent: Ref<"mutation", { id: string; event: string; payload?: any }, boolean>;
    cancel: Ref<"mutation", { id: string }, boolean>;
    cleanup: Ref<"mutation", { id: string }, boolean>;
  };
}

/** A workflow's driver: the internalAction `define` returns (export it from an ember/ module). */
export type WorkflowDefinition<Args, Ret> = RegisteredAction<"internal", { workflowId: string; args: Args; journal: JournalEntry[] }, Outcome> & {
  /** Phantom: the workflow's own args and result. */
  readonly __workflow?: { args: Args; returns: Ret };
};

/** Mutation/query ctx (sync `run*`) or action ctx (async). */
type SyncCtx = { db: unknown; runQuery(fn: any, args?: any): any; runMutation?(fn: any, args?: any): any };
type AsyncCtx = { runAction(fn: any, args?: any): Promise<any>; runQuery(fn: any, args?: any): Promise<any>; runMutation(fn: any, args?: any): Promise<any> };

type WorkflowRef<A> = FunctionReference<"action", "internal", { workflowId: string; args: A; journal: JournalEntry[] }, Outcome> | string;

export type OnComplete = { workflowId: string; outcome: { kind: "success"; result: unknown } | { kind: "failed"; error: string } | { kind: "canceled" }; context: unknown };

export interface StartOptions {
  /** A mutation run (in the finishing transaction) with `OnComplete` args. */
  onComplete?: FunctionReference<"mutation", any, OnComplete, any> | string;
  /** Passed back to onComplete. */
  context?: unknown;
}

export class WorkflowManager {
  constructor(
    readonly component: WorkflowsComponentApi,
    readonly options: { defaultRetry?: RetryPolicy } = {},
  ) {}

  /**
   * Defines a workflow: returns its driver, an internalAction to export from an ember/ module. `handler` must be
   * deterministic: all effects through `step.*`. Action steps retry per `retry` (default: `defaultRetry`, else
   * none); query and mutation steps run once, in the same transaction as their journal entry.
   */
  define<A extends ArgsValidator, R>(def: { args?: A; handler: (step: WorkflowStep, args: ArgsType<A>) => Promise<R> }): WorkflowDefinition<ArgsType<A>, R> {
    const argsValidator = def.args === undefined ? v.unsafeAny() : "shape" in (def.args as object) && typeof (def.args as any).validate === "function" ? (def.args as any) : v.object(def.args as any);
    return internalActionGeneric({
      args: { workflowId: v.string(), args: argsValidator, journal: v.array(v.unsafeAny()) },
      handler: async (_ctx, input: { workflowId: string; args: any; journal: JournalEntry[] }) =>
        replay(def.handler as any, { workflowId: input.workflowId, args: input.args, journal: input.journal, ...(this.options.defaultRetry ? { defaultRetry: this.options.defaultRetry } : {}) }),
    }) as unknown as WorkflowDefinition<ArgsType<A>, R>;
  }

  private startArgs(workflow: WorkflowRef<any>, args: unknown, o: StartOptions) {
    const a: { driver: string; args: unknown; onComplete?: string; context?: unknown } = { driver: createFunctionHandle(workflow as any), args: args ?? {} };
    if (o.onComplete) a.onComplete = createFunctionHandle(o.onComplete as any);
    if (o.context !== undefined) a.context = o.context;
    return a;
  }

  /** Starts a workflow in the caller's shard. In a mutation: atomic with it (synchronous). Returns its id. */
  start<A>(ctx: SyncCtx, workflow: WorkflowRef<A>, args: A, opts?: StartOptions): string;
  start<A>(ctx: AsyncCtx, workflow: WorkflowRef<A>, args: A, opts?: StartOptions): Promise<string>;
  start(ctx: SyncCtx | AsyncCtx, workflow: WorkflowRef<any>, args: unknown, opts: StartOptions = {}): string | Promise<string> {
    if (!ctx.runMutation) throw new Error("workflow.start needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.start, this.startArgs(workflow, args, opts));
  }

  status(ctx: SyncCtx, id: string): WorkflowStatus | null;
  status(ctx: AsyncCtx, id: string): Promise<WorkflowStatus | null>;
  status(ctx: SyncCtx | AsyncCtx, id: string) {
    return ctx.runQuery(this.component.lib.status, { id });
  }

  /** The journal: one entry per step with status, attempts, result or error. */
  steps(ctx: SyncCtx, id: string): any[];
  steps(ctx: AsyncCtx, id: string): Promise<any[]>;
  steps(ctx: SyncCtx | AsyncCtx, id: string) {
    return ctx.runQuery(this.component.lib.steps, { id });
  }

  /** Delivers an event to `waitForEvent` (buffered if the workflow is not waiting yet). */
  sendEvent(ctx: SyncCtx, id: string, event: string, payload?: unknown): boolean;
  sendEvent(ctx: AsyncCtx, id: string, event: string, payload?: unknown): Promise<boolean>;
  sendEvent(ctx: SyncCtx | AsyncCtx, id: string, event: string, payload?: unknown) {
    if (!ctx.runMutation) throw new Error("workflow.sendEvent needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.sendEvent, payload === undefined ? { id, event } : { id, event, payload });
  }

  cancel(ctx: SyncCtx, id: string): boolean;
  cancel(ctx: AsyncCtx, id: string): Promise<boolean>;
  cancel(ctx: SyncCtx | AsyncCtx, id: string) {
    if (!ctx.runMutation) throw new Error("workflow.cancel needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.cancel, { id });
  }

  /** Deletes a finished workflow and its journal. */
  cleanup(ctx: SyncCtx, id: string): boolean;
  cleanup(ctx: AsyncCtx, id: string): Promise<boolean>;
  cleanup(ctx: SyncCtx | AsyncCtx, id: string) {
    if (!ctx.runMutation) throw new Error("workflow.cleanup needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.cleanup, { id });
  }
}
