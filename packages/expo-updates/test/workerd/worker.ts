/**
 * The workerd test app: the expo-updates component installed twice (the default mount, and `fast` with a 1 s plan TTL),
 * no app functions. Publishing goes through the admin function runner, as `ember expo publish` does.
 */
import { defineApp, defineSchema } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { expoUpdates } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";
export { expoUpdatesProbes } from "../../src/index.ts";

export const schema = defineSchema({ tables: {} });
export const app = defineApp().use(expoUpdates).use(expoUpdates, { name: "fast", config: { cache: { planTtlSeconds: 1 } } });

export default createEmberWorker({ schema, functions: {}, app });
