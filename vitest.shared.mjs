// Tests resolve the @freecorps/ember-* workspace packages to their TypeScript sources through the
// "@freecorps/ember-source" export condition (see each package.json "exports"), so no build is needed to test.
// The workerd configs only add the condition: @cloudflare/vitest-plugin appends its own (workerd, worker, ...).
export const SOURCE_CONDITION = "@freecorps/ember-source";

/** Vite resolve options for Node / happy-dom test environments. */
export const sourceResolve = {
  resolve: { conditions: [SOURCE_CONDITION, "module", "browser", "development|production"] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, "module", "node", "development|production"] } },
};

/** For configs using @cloudflare/vitest-plugin. */
export const workerdSourceResolve = {
  resolve: { conditions: [SOURCE_CONDITION] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, "workerd", "worker", "module", "browser", "development|production"] } },
};
