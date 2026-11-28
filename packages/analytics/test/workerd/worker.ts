/**
 * The workerd test app: the analytics component installed with the raw archive on, and one app mutation (the baseline
 * that does write a row). The Worker's env gets a fake Analytics Engine binding (`EMBER_ANALYTICS`) that keeps the
 * points it is given, so the test sees exactly what `writeDataPoint` received.
 */
import { defineApp, defineSchema, defineTable, mutationGeneric, queryGeneric, v } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { analytics, type DataPoint } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

export const probes = { points: [] as DataPoint[] };

const schema = defineSchema({ tables: { notes: defineTable({ text: v.string() }) } });
const functions = {
  api: {
    add: mutationGeneric({ args: { text: v.string() }, handler: (ctx: any, a: { text: string }) => ctx.db.insert("notes", { text: a.text }) }),
    count: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("notes").collect().length }),
  },
};

const app = defineApp().use(analytics, { config: { dimensions: ["plan"], archive: true, maxEvents: 50 } });
const ember = createEmberWorker({ schema, functions, app });
const dataset = { writeDataPoint: (p?: unknown) => void probes.points.push(p as DataPoint) };

export default {
  ...ember,
  fetch: (request: Request, env: Record<string, unknown>, ctx: ExecutionContext) => ember.fetch(request as never, { ...env, EMBER_ANALYTICS: dataset } as never, ctx),
};
