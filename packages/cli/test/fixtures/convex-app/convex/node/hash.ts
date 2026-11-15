"use node";

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";

export const digest = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => createHash("sha256").update(text).digest("hex"),
});
