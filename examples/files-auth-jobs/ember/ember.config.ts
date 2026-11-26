// The app's own screens in the Ember Dashboard (contracts.md "Telas declarativas"): plain data naming this app's
// functions by reference. The dashboard renders them under "App screens", runs only these functions, and applies its
// roles, CSRF, audit log and typed confirmations (the destructive one asks for its name on protected environments).
import { defineApp } from "@freecorps/ember-server";
import { api, internal } from "./_generated/api";

export default defineApp({
  dashboard: {
    label: "Operations",
    icon: "list",
    description: "Exchange rates and the uploads job.",
    // `fxRates` is written on global:main (it replicates to the org shards from there).
    scope: "global",
    tabs: [
      {
        id: "rates",
        label: "Exchange rates",
        blocks: [
          {
            kind: "table",
            id: "rates",
            label: "Rates",
            query: internal.rates.all,
            columns: [
              { label: "Base", path: "base", format: "code" },
              { label: "Quote", path: "quote", format: "code" },
              { label: "Rate", path: "rate", format: "number" },
            ],
          },
          {
            kind: "actions",
            id: "maintenance",
            label: "Maintenance",
            actions: [
              { id: "setRate", label: "Set a rate", fn: api.rates.setRate },
              { id: "sweep", label: "Re-run stuck uploads", fn: internal.files.sweep, destructive: true, description: "Schedules the processing job again for uploads stuck in processing." },
            ],
          },
        ],
      },
    ],
  },
});
