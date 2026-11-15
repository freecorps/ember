// From the convex-helpers Triggers found by `ember migrate convex` (contracts.md "Triggers").
import { defineTriggers } from "./_generated/server";
import { notesTrigger, notesTrigger2 } from "./functions";

export default defineTriggers({
  notes: [notesTrigger, notesTrigger2],
});
