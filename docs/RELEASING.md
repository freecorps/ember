# Releasing to npm

All publishable packages (`packages/*`, not `private`) share one version and are published together under the
`@freecorps` scope: values, server, runtime, client, react, react-query, react-native, push, auth, cli.
`apps/*` are private and never published (the CLI ships a prebuilt copy of the dashboard).

## How the packages are built

- `bun run build` writes `packages/*/dist` (ESM JS + `.d.ts`). Libraries use plain `tsc -p tsconfig.build.json`
  (`rewriteRelativeImportExtensions`). The CLI JS is one esbuild bundle (it inlines the private `apps/dashboard`
  modules), with `.d.ts` from tsc, plus `dist/dashboard/{app.js,app.css,worker.js}`.
- `exports` point to `dist/` with `types` conditions. Inside the repo, the extra `@freecorps/ember-source`
  condition maps each entry to `src/*.ts`. tsconfig `customConditions`, Vitest (`vitest.shared.mjs`), Metro, and
  the CLI (when it runs from `src/`) all enable it, so tests, typecheck and `ember dev` never need a build.
  We chose a custom condition over `publishConfig.exports` because npm ignores `publishConfig.exports` (only pnpm
  applies it), and because one `exports` map serves every tool.
- `bin/ember.js` imports `dist/index.js` when `src/` is absent (the published package), so the CLI runs on plain
  Node >= 22 with no flags.

## Staging (what actually gets published)

`bun scripts/release.ts stage` copies each package to `.release/<dir>/` and rewrites its `package.json`:

- `workspace:*` is pinned to the exact shared version (`workspace:^`/`~` become `^x.y.z`/`~x.y.z`);
- the `@freecorps/ember-source` condition is removed (it points at `src/`, which is not shipped);
- `scripts` and `devDependencies` are removed. Root `LICENSE` and a short README are added.

npm (not `bun publish`) does the publishing, because the workflow needs `npm publish --provenance` and npm
trusted publishing. npm itself would publish `workspace:*` unchanged, which is why we stage first.

## Checks before a release

```sh
bun run check
bun run build
bun run verify:pack            # bun scripts/verify-pack.ts [--node /path/to/node22] [--keep]
bun scripts/release.ts publish --dry-run --no-build
```

`verify:pack` packs every package and installs the tarballs into a temp project outside the repo. It then runs
`ember --help`, `npx @freecorps/ember-cli --help`, `ember init`, `ember codegen`, `tsc --noEmit` on the sample app,
and consumer type checks (bundler and NodeNext). It also imports the packages on Node, builds the dashboard from
the prebuilt copy, and does an `ember dev` mutation + query round-trip. It deletes the temp dirs afterwards.

## Publishing (GitHub Actions, recommended)

1. Bump the version in every `packages/*/package.json` (they must all match), commit, and merge.
2. `git tag v0.1.0 && git push origin v0.1.0`.
3. `.github/workflows/release.yml` runs `verify-pack` on Node 22 and 24, then `check`, `build` and
   `bun scripts/release.ts publish --provenance --expect-version v0.1.0`. The job fails if the tag does not match
   the package versions. Versions already on npm are skipped, so a partially failed release can be re-run.

You can also start the workflow by hand (Actions → release → Run workflow). It is a dry run by default. Pick a
`dist_tag` (for example `next`) for prereleases.

### npm authentication: pick one

1. **`NPM_TOKEN` secret** (needed for the first publish): create an npm *granular access token* with read and
   write on the `@freecorps` scope (and "bypass 2FA" if the org enforces 2FA for writes). Store it as the
   `NPM_TOKEN` repository secret. `actions/setup-node` writes an `.npmrc` that reads it from `NODE_AUTH_TOKEN`.
2. **Trusted Publishing (OIDC)**, once the packages exist on npm: on npmjs.com, open each package → Settings →
   Trusted publisher → GitHub Actions. Set organization `freecorps`, repository `ember`, workflow `release.yml`.
   npm >= 11.5.1 (bundled with Node 24) then publishes with the job's OIDC token (`id-token: write`), and you can
   delete `NPM_TOKEN`. Restricting the publish to a GitHub environment is optional hardening (add `environment:`
   to the job and the same name in npm).

Both options publish with provenance.

## Publishing by hand (fallback)

```sh
npm login                                  # an account with publish rights on @freecorps
bun run build
bun scripts/release.ts publish --no-build  # add --tag next for prereleases; --provenance only works in CI
```
