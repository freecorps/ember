# @freecorps/ember-workflows

Durable multi-step functions for [Ember](https://github.com/freecorps/ember) apps, as a component on the shard
scheduler: journaled steps, durable sleeps (years are fine), events, retries for action steps and a completion
callback. Starting a workflow is atomic with the mutation that starts it, and its status is a reactive query.

```sh
npm install @freecorps/ember-workflows
```

## Example

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { workflows } from "@freecorps/ember-workflows";
export default defineApp().use(workflows);

// ember/onboarding.ts
import { v } from "@freecorps/ember-server";
import { WorkflowManager } from "@freecorps/ember-workflows";
import { internal } from "./_generated/api";
import { components, mutation, query } from "./_generated/server";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const workflow = new WorkflowManager(components.workflows);

export const onboard = workflow.define({
  args: { domain: v.string() },
  handler: async (step, { domain }) => {
    const zone = await step.runAction(internal.domains.createZone, { domain }, { retry: { maxAttempts: 5 } });
    await step.sleep(10 * MINUTE);
    const dns = await step.waitForEvent<{ ok: boolean }>("dns-verified", { timeoutMs: DAY });
    await step.runMutation(internal.domains.activate, { zone, ok: dns.ok });
    return zone;
  },
});

export const start = mutation({
  args: { domain: v.string() },
  handler: (ctx, { domain }) => workflow.start(ctx, internal.onboarding.onboard, { domain }), // atomic with the mutation
});
export const progress = query({ args: { id: v.string() }, handler: (ctx, { id }) => workflow.status(ctx, id) }); // reactive
// elsewhere: workflow.sendEvent(ctx, id, "dns-verified", { ok: true })
```

## What you get

- `new WorkflowManager(components.workflows, { defaultRetry? })`; `define({ args, handler })` returns the driver, an
  internal action you export from an `ember/` module.
- Steps: `step.runQuery`, `step.runMutation`, `step.runAction` (each `(ref, args, { name?, retry? })`),
  `step.sleep(ms)`, `step.sleepUntil(time)`, `step.waitForEvent(event, { timeoutMs? })`.
- `workflow.start(ctx, ref, args, { onComplete?, context? })`, `status`, `steps` (the journal), `sendEvent` (buffered
  if the workflow is not waiting yet), `cancel`, `cleanup`. In a mutation these are synchronous; in an action,
  Promises.
- `onComplete` is a mutation run in the transaction that finishes the workflow (`completed`, `failed` or
  `canceled`); if it throws, its writes are undone and the error is logged.
- `cleanup` removes the workflow at once (`status` → null); a journal of more than 200 rows is deleted by follow-up
  jobs, 200 rows each.

## Delivery and limits

- Query and mutation steps run **exactly once**, in the same transaction as their journal entry. Action steps run
  **at least once** and retry per `retry` (`{ maxAttempts, initialBackoffMs?, base? }`; default none, or
  `defaultRetry`).
- The handler must be deterministic: every effect goes through `step.*`. It is replayed on each step (O(n²) CPU in
  steps; `maxSteps` defaults to 1000). One drive run loads the journal once and runs up to 16 query/mutation steps
  in a row before it hands over to a new job, so rows read stay linear. A journal that no longer matches the code
  fails with `NonDeterminism`.
- Parallel steps (`Promise.all`) are not supported yet: the first new step suspends the handler.
- The workflow lives in the caller's shard; throughput is that shard's.
- Built on the shard scheduler rather than Cloudflare Workflows; contracts.md explains why.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Componentes" → `workflows`. Tests with usage: [`packages/workflows/test`](https://github.com/freecorps/ember/tree/main/packages/workflows/test).

License: MIT.
