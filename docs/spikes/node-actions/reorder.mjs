// node reorder.mjs rows-N.xlsx: same workbook with the worksheets moved to the end of the zip (rels, shared strings first) (→ rows-N.ss-first.xlsx).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { FIXTURES } from "./harness.mjs";
const name = process.argv[2];
const files = unzipSync(readFileSync(join(FIXTURES, name)));
const sheet = (k) => k.startsWith("xl/worksheets/");
const order = Object.keys(files).sort((a, b) => sheet(a) - sheet(b)); // worksheets last: rels and shared strings first
writeFileSync(join(FIXTURES, name.replace(".xlsx", ".ss-first.xlsx")), zipSync(Object.fromEntries(order.map((k) => [k, files[k]])), { level: 6 }));
console.log(order.slice(0, 3).join(", "));
