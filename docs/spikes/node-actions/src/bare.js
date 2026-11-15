// Bare Node specifiers ("fs", not "node:fs"), as most npm packages written for Node use them.
import fs from "fs";
import { Readable } from "stream";
import { createHash } from "crypto";
import { EventEmitter } from "events";
import { serve } from "./_serve.js";

export default serve({
  async run() {
    return { fs: typeof fs.readFileSync, readable: typeof Readable, hash: createHash("sha1").update("x").digest("hex").slice(0, 8), ee: typeof EventEmitter };
  },
});
