"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { Workbook } from "exceljs";

export const thumbnail = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => {
    const input = await readFile(url);
    return (await sharp(input).resize(64).toBuffer()).byteLength;
  },
});

export type Sheet = Workbook;
