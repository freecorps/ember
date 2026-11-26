# @freecorps/ember-dashboard-sdk

The page side of an **`embed` block** in the [Ember](https://github.com/freecorps/ember) Dashboard: a component or
app shows a page of its own (an email preview, a chat playground) inside one of its dashboard screens, with no
dashboard code. Zero dependencies, browser-only (the page side); `embedPage` and `EMBED_SDK_SCRIPT` are plain strings
you can build anywhere, a Worker included.

```sh
npm install @freecorps/ember-dashboard-sdk
```

## How it works

1. The component declares the block and the functions the page may call (refs, as for any block):

   ```ts
   dashboard: {
     label: "Email", icon: "mail",
     tabs: [{ id: "preview", label: "Preview", blocks: [
       { kind: "embed", route: "/dashboard/preview", height: "auto", functions: [dashboard.outbox, dashboard.preview] },
     ] }],
   },
   http: httpRouter().route({ path: "/dashboard/preview", method: "GET", handler: httpAction(async () =>
     new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })) }),
   ```

   `route` is a `GET` route of the component's own `http` router (a plain path: no scheme, host, query or `..`).

2. The dashboard fetches that route server-side through the project's admin channel and serves it from its own
   origin inside an `<iframe sandbox="allow-scripts">` (an opaque origin: no cookies, storage or DOM of the
   dashboard), under a CSP with **no network** (`connect-src 'none'`, images and fonts only `data:`/`blob:`) and
   only the page's own inline scripts, allowed by their SHA-256 hash. `frame-ancestors` is the dashboard's origin.

3. The page talks to the dashboard only through this SDK (`postMessage`). Queries run right away; every mutation or
   action opens the dashboard's confirmation dialog first, showing the component, the function and the args, and is
   audited as `dashboard.embed.run`. Only the functions the block lists can be called.

The route is a public route like any other: serve only the static document. The data comes through the bridge, for
the person signed in to the dashboard.

## The page

The page cannot load anything (no network), so it inlines the SDK. `embedPage` builds the whole document:

```ts
import { embedPage } from "@freecorps/ember-dashboard-sdk";

export const PAGE = embedPage({
  title: "Email preview",
  body: `<button id="reload">Reload</button><ul id="list"></ul>`,   // no <script> here (refused): code goes in `script`
  style: `ul { padding: 0 }`,                         // inline styles are allowed; use the theme's variables
  // A classic script (no top-level await, no imports): it runs after the SDK.
  script: `
    const dash = EmberDashboard.connect();
    dash.query("dashboard:outbox", { paginationOpts: { numItems: 20, cursor: null } }).then((r) => {
      // ... draw r.page with textContent (never innerHTML of data) ...
      dash.ready();
    });
  `,
});
```

Or put `EMBED_SDK_SCRIPT` in a `<script>` yourself, before the page's own script. It is the SDK built as one classic
script that defines `window.EmberDashboard = { connect, DashboardError }`, shipped as a string so no bundler changes
it. With a bundler of your own for the page, `import { connect } from "@freecorps/ember-dashboard-sdk"` works too,
as long as the result ends up inline in the HTML.

## API

```ts
const dash = connect({ applyTheme?: boolean, autoResize?: boolean, queryTimeoutMs?: number });

await dash.query<T>("dashboard:threads", args);   // a query the block lists
await dash.mutate<T>("lib:send", args);            // confirmed by the person first; rejects `cancelled` if declined
await dash.action<T>("lib:run", args);             // the same, for an action
dash.theme;                                        // { mode: "light" | "dark", vars: { "--bg": ..., ... } } | null
await dash.context;                                // { project, env, shard, dashboard, block, functions, role }
const off = dash.onTheme((t) => { ... });          // on the handshake and on every change
dash.resize(height?);                              // a block with height "auto" (automatic with ResizeObserver)
dash.ready();                                      // the page has drawn
dash.close();                                      // pending requests (and context) reject `disconnected`
```

Requests made before the handshake wait for it (with a copy of their args taken at the call); a query's timeout
counts from when the dashboard receives it. With no dashboard around the page (no `welcome` after about 20 s of
hellos), the bridge closes the same way.

Names are the component's local names (`dashboard:threads`, `lib:send`). A failure rejects with a `DashboardError`
whose `code` is `not_allowed` (the block does not list it, or another kind), `busy` (another write is waiting for
confirmation, or too many queries in flight), `cancelled`, `forbidden` (read role), `bad_request`, `timeout`
(queries only), `disconnected`, or the function's own error code.

By default the theme lands on `<html>` as CSS variables (`--bg`, `--surface`, `--fg`, `--muted`, `--line`,
`--accent`, `--accent-fg`, `--ok`, `--bad`, `--warn`, `--radius`, `--sans`, `--mono`, ...), plus `data-theme` and
`color-scheme`. Pass `applyTheme: false` and use `onTheme` to apply it yourself.

## Security model

- The SDK accepts only messages whose `event.source` is `window.parent`. The first `welcome` pins the dashboard's
  origin (the browser's `event.origin`); after that it accepts only that origin and always posts to it, never `"*"`.
  Only the initial `hello` (which carries nothing) goes to `"*"`.
- The dashboard listens only to that iframe's `contentWindow`, stops answering once the iframe navigates away, allows
  one pending confirmation at a time, and runs only the functions the block lists (the dashboard's Worker checks the
  block again).
- The page can navigate its own frame, so it could carry away what it read. The model protects the dashboard
  (credentials, DOM, unconfirmed writes), not data from the component's own code.

Full contract: `docs/design/contracts.md`, "Dashboard" → "Embeds".
