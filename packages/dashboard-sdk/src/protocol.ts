// The bridge protocol between a page embedded in the Ember Dashboard (an `embed` block, in an iframe sandboxed with
// `allow-scripts` only: an opaque origin) and the dashboard around it (docs/design/contracts.md "Dashboard", "Embeds").
// Every message is a plain object `{ ember: "dashboard-embed", v: 1, type, ... }`.
//
//   page → dashboard   hello                       (repeated until the welcome; carries nothing)
//                      request { id, op, name, args }   op: "query" | "mutate" | "action"
//                      resize { height }           (a block with height "auto")
//                      ready                       (the page has drawn: the dashboard stops showing "Loading…")
//   dashboard → page   welcome { theme, context }  (answers the first hello; its `event.origin` is the dashboard's)
//                      response { id, ok, value | error }
//                      theme { theme }             (the person switched light/dark)
//
// The page only accepts messages whose `event.source` is its parent window; after the welcome, only from the
// welcome's origin, and it posts to that origin (never "*"). The dashboard only accepts messages whose
// `event.source` is the iframe's own `contentWindow` (an opaque origin cannot be checked by name), and stops
// answering once the iframe navigates away from the page it loaded.

export const EMBED_PROTOCOL = "dashboard-embed";
export const EMBED_PROTOCOL_VERSION = 1;

/** What the page may ask for: `query` runs a query, `mutate` a mutation, `action` an action (the last two confirmed). */
export type EmbedOp = "query" | "mutate" | "action";

/** The dashboard's look, as CSS custom properties (`--bg`, `--fg`, `--accent`, `--radius`, `--sans`, ...). */
export interface DashboardTheme {
  mode: "light" | "dark";
  vars: Record<string, string>;
}

/** Where the page is shown. */
export interface EmbedContext {
  project: string;
  env: string;
  /** The shard the screen runs on. */
  shard: string;
  /** The dashboard spec's key (`""`: the app's; a component's install path). */
  dashboard: string;
  /** The block's id. */
  block: string;
  /** Local names of the functions the block lets the page call (`dashboard:threads`). */
  functions: string[];
  /** The signed-in role: a `read` role cannot run mutations or actions (they are refused with `forbidden`). */
  role: "read" | "admin";
}

/** Codes a request may fail with besides the function's own (`ValidationError`, an app's `defineErrors` code, ...). */
export type EmbedErrorCode =
  /** The block does not list this function, or it is of another kind than `op`. */
  | "not_allowed"
  /** Another write is waiting for the person's confirmation, or too many queries are in flight. */
  | "busy"
  /** The person declined the confirmation. */
  | "cancelled"
  /** The role cannot write (read role). */
  | "forbidden"
  /** Malformed request (args not an object, too large). */
  | "bad_request"
  /** No answer in time (queries only: a write waits for the person). */
  | "timeout"
  /** The page was disconnected (it navigated away, or the block was closed). */
  | "disconnected";

export interface EmbedErrorInfo {
  code: string;
  message: string;
  data?: unknown;
}

export type PageMessage =
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "hello" }
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "request"; id: string; op: EmbedOp; name: string; args: Record<string, unknown> }
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "resize"; height: number }
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "ready" };

export type HostMessage =
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "welcome"; theme: DashboardTheme; context: EmbedContext }
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "response"; id: string; ok: true; value: unknown }
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "response"; id: string; ok: false; error: EmbedErrorInfo }
  | { ember: typeof EMBED_PROTOCOL; v: typeof EMBED_PROTOCOL_VERSION; type: "theme"; theme: DashboardTheme };

/** Largest height a page may ask for (pixels); the dashboard clamps to [MIN, MAX]. */
export const EMBED_HEIGHT_MIN = 40;
export const EMBED_HEIGHT_MAX = 4000;

/** A CSS custom property name the SDK applies (anything else in a theme is ignored). */
export const THEME_VAR = /^--[A-Za-z0-9-]{1,60}$/;
