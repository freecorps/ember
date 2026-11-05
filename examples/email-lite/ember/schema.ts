import { defineSchema } from "@freecorps/ember-server";

// The app has no tables of its own: everything lives in the component's tables (`email$*`).
export default defineSchema({ tables: {} });
