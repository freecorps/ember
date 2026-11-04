#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 24 strips types). A build step comes before publishing.
import { main } from "../src/main.ts";

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ember: ${err?.message ?? err}`);
    if (process.env.EMBER_DEBUG) console.error(err);
    process.exit(1);
  },
);
