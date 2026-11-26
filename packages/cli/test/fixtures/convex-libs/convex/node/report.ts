"use node";
import { action } from "../_generated/server";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import { pad } from "left-pad-pro/strings";
// The bare builtin name on purpose (older code has it): it must map to node:crypto (images.ts has a node: one).
import * as crypto from "crypto";

export const report = action({
  args: {},
  handler: async () => {
    const wb = new ExcelJS.Workbook();
    const ai = new OpenAI();
    void ai;
    return pad(crypto.randomUUID(), 40) + wb.creator;
  },
});
