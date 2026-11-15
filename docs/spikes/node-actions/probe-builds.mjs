import { build } from "./harness.mjs";
for (const e of process.argv.slice(2)) for (const variant of ["ember", "fixed", "neutral"]) {
  const r = await build(e, { variant });
  console.log(e, variant, r.ok ? `ok ${(r.bytes / 1024).toFixed(0)} KiB (gz ${(r.gzipBytes / 1024).toFixed(0)} KiB)` : `FAIL ${r.error}`);
}
