// Declarative dashboard screens (contracts.md "Dashboard", "Telas declarativas"): a component or an app describes the
// screens the Ember Dashboard shows for it — `defineComponent({ dashboard })`, `defineApp({ dashboard })` — as plain
// data. The dashboard renders the blocks generically, runs only the functions the spec names (the runtime's allowlist),
// generates filters and forms from those functions' `v.*` args, and applies its roles, CSRF, audit log and typed
// confirmations to every write.
//
// A spec names functions by typed reference only (dx.md): a registered function of the component itself
// (`functions.lib.stats`), or a reference (`internal.mod.fn` from `_generated/api`) in an app. Strings are refused.
// `resolveDashboard` checks the spec (refs that exist, the right kind of function, args that fit the function's
// validators) and turns it into the serializable `DashboardSpec` the manifest and the admin API carry.

import { validate, type FieldShape, type ObjectShape, type Shape } from "@freecorps/ember-values";
import { getFunctionName, IS_FUNCTION, isRegisteredFunction, type AnyRegisteredFunction, type FunctionType, type RegisteredHttpAction } from "./functions.ts";
import { matchRoute, type HttpRoute } from "./http.ts";

// ------------------------------------------------------------------------------------------------ input (authoring)

/**
 * A function a block runs, by typed reference: a registered function (`functions.lib.list`, in a component) or a
 * reference (`internal.jobs.list`, in an app). Never a string.
 */
export type DashboardFn<T extends FunctionType = FunctionType> =
  | { readonly [IS_FUNCTION]: true; readonly type: T; readonly args: ObjectShape }
  | { readonly _type: T };
export type DashboardQuery = DashboardFn<"query">;
export type DashboardMutation = DashboardFn<"mutation">;
export type DashboardWrite = DashboardFn<"mutation" | "action">;

/** How a value is shown. */
export type DashboardFormat = "text" | "number" | "bytes" | "ms" | "date" | "ago" | "percent" | "boolean" | "badge" | "code" | "json";
export const DASHBOARD_FORMATS: readonly DashboardFormat[] = ["text", "number", "bytes", "ms", "date", "ago", "percent", "boolean", "badge", "code", "json"];

/** Icons the dashboard draws (anything else is refused, so a spec never names one it lacks). */
export const DASHBOARD_ICONS = ["box", "queue", "database", "workflow", "gauge", "bell", "mail", "bot", "list", "clock", "shield", "chart", "key", "flag"] as const;
export type DashboardIcon = (typeof DASHBOARD_ICONS)[number];

/** Values of the args a block always sends (a preset of the form; they are validated by the function's `v.*`). */
export type DashboardArgs = Readonly<Record<string, unknown>>;
/** Args filled from the clicked row: `{ <arg>: "<path in the row>" }` (`{ id: "_id" }`). */
export type DashboardFromRow = Readonly<Record<string, string>>;

export interface DashboardField {
  label: string;
  /** Dot path into the value (`totals.enqueued`, `items.0.name`; `""`: the value itself). */
  path: string;
  format?: DashboardFormat;
}

export interface DashboardActionInput<F extends DashboardWrite = DashboardWrite> {
  /** Unique in its block (default: from its position). */
  id?: string;
  label: string;
  /** A mutation or action of this component/app. The form is generated from its `v.*` args. */
  fn: F;
  args?: DashboardArgs;
  /** Row actions: args taken from the row. */
  fromRow?: DashboardFromRow;
  description?: string;
  /** Asks for a typed confirmation in protected environments (prod), checked again by the dashboard's Worker. */
  destructive?: boolean;
}

export interface DashboardToggleColumn {
  /** The mutation that sets the value: called with `{ ...args, ...fromRow, [arg]: !current }`. */
  mutation: DashboardMutation;
  /** Its boolean argument. */
  arg: string;
  args?: DashboardArgs;
  fromRow?: DashboardFromRow;
}

export interface DashboardColumn extends DashboardField {
  /** An inline switch for a boolean column (admin role). */
  toggle?: DashboardToggleColumn;
}

export type DashboardSectionInput =
  | { kind: "kv"; label?: string; path?: string; items: DashboardField[] }
  | { kind: "timeline"; label?: string; path: string; time: string; title: string; detail?: string; status?: string }
  | { kind: "code"; label?: string; path: string; language?: string }
  | { kind: "stacktrace"; label?: string; path: string }
  | { kind: "json"; label?: string; path?: string }
  | { kind: "chart"; label?: string; path: string; x: string; y: string[]; type?: "line" | "bar" };

export interface DashboardDetailInput {
  /** The query that loads one item. Standalone: its args become a form; in a table: `fromRow` fills them. */
  query: DashboardQuery;
  args?: DashboardArgs;
  fromRow?: DashboardFromRow;
  sections: DashboardSectionInput[];
}

interface BlockBase {
  /** Unique in its tab (default: from its position). */
  id?: string;
  label?: string;
  description?: string;
}

export type DashboardBlockInput =
  | (BlockBase & { kind: "stats"; query: DashboardQuery; args?: DashboardArgs; items: DashboardField[] })
  | (BlockBase & {
      kind: "table";
      query: DashboardQuery;
      args?: DashboardArgs;
      /** Path of the rows in the result (default: the result, or its `page` when the query is paginated). */
      rows?: string;
      columns: DashboardColumn[];
      /** Args offered as filters (default: every arg except `paginationOpts` and the fixed `args`). */
      filters?: string[];
      /** Rows per page of a paginated query (an arg `paginationOpts: paginationOptsValidator`); default 25, max 200. */
      pageSize?: number;
      /** Path of a row's key (default `_id`). */
      rowKey?: string;
      /** Clicking a row opens this detail. */
      detail?: DashboardDetailInput;
      rowActions?: DashboardActionInput[];
    })
  | (BlockBase & { kind: "detail" } & DashboardDetailInput)
  | (BlockBase & {
      kind: "toggle";
      label: string;
      /** Reads the current value (`path` in its result). */
      query: DashboardQuery;
      args?: DashboardArgs;
      path: string;
      mutation: DashboardMutation;
      arg: string;
      mutationArgs?: DashboardArgs;
    })
  | (BlockBase & { kind: "actions"; actions: DashboardActionInput[] })
  | (BlockBase & DashboardEmbedInput);

/**
 * A page of the component's (or app's) own, shown in a sandboxed iframe (contracts.md "Dashboard", "Embeds"): the
 * dashboard loads `route` (a `GET` route of its `http` router) through its own Worker, serves it under a strict CSP
 * (inline scripts allowed by hash only, no network), and the page talks to the dashboard only through
 * `@freecorps/ember-dashboard-sdk` (`postMessage`): it may run the `functions` listed here, by their local names, and
 * every mutation or action is confirmed by the person in the dashboard first.
 */
export interface DashboardEmbedInput {
  kind: "embed";
  /** Path of a `GET` route of this component's (app's) `http` router, as declared there (`/dashboard/playground`). */
  route: string;
  /** Pixels, or `"auto"` (default): the page sets it with `dash.resize(height)`. */
  height?: number | "auto";
  /** Functions the page may call through the SDK (`dash.query("dashboard:threads", ...)`): the embed's allowlist. */
  functions?: DashboardFn[];
}

export interface DashboardTabInput {
  id: string;
  label: string;
  blocks: DashboardBlockInput[];
}

/** `defineComponent({ dashboard })` / `defineApp({ dashboard })`. */
export interface DashboardSpecInput {
  label: string;
  icon?: DashboardIcon;
  description?: string;
  /**
   * `"shard"` (default): the screens run on the shard picked in the dashboard (a component's tables live in every
   * shard). `"global"`: always on `global:main`.
   */
  scope?: "shard" | "global";
  tabs: DashboardTabInput[];
}

// ------------------------------------------------------------------------------------------------ resolved (manifest)

/** One function a spec runs: what the dashboard needs to build its forms and the runtime to allow it. */
export interface DashboardFunction {
  type: "query" | "mutation" | "action";
  args: ObjectShape;
  /** Some action of the spec that runs it is destructive (typed confirmation in protected environments). */
  destructive?: true;
}

export interface DashboardAction {
  id: string;
  label: string;
  fn: string;
  args?: Record<string, unknown>;
  fromRow?: Record<string, string>;
  description?: string;
  destructive?: true;
}

export interface DashboardDetail {
  query: string;
  args?: Record<string, unknown>;
  fromRow?: Record<string, string>;
  sections: DashboardSectionInput[];
}

export type DashboardColumnSpec = DashboardField & { toggle?: { mutation: string; arg: string; args?: Record<string, unknown>; fromRow?: Record<string, string> } };

export type DashboardBlock =
  | { kind: "stats"; id: string; label?: string; description?: string; query: string; args?: Record<string, unknown>; items: DashboardField[] }
  | {
      kind: "table";
      id: string;
      label?: string;
      description?: string;
      query: string;
      args?: Record<string, unknown>;
      rows?: string;
      columns: DashboardColumnSpec[];
      filters: string[];
      /** Set when the query is paginated (`paginationOpts`). */
      pageSize?: number;
      rowKey: string;
      detail?: DashboardDetail;
      rowActions?: DashboardAction[];
    }
  | ({ kind: "detail"; id: string; label?: string; description?: string } & DashboardDetail)
  | { kind: "toggle"; id: string; label: string; description?: string; query: string; args?: Record<string, unknown>; path: string; mutation: string; arg: string; mutationArgs?: Record<string, unknown> }
  | { kind: "actions"; id: string; label?: string; description?: string; actions: DashboardAction[] }
  | DashboardEmbed;

/** A resolved embed block. */
export interface DashboardEmbed {
  kind: "embed";
  id: string;
  label?: string;
  description?: string;
  /** The route as the component declares it (relative to its HTTP mount). */
  route: string;
  /** Where the route is served in the deployment (`/agent/dashboard/playground`): set by `composeApp`. */
  path?: string;
  height: number | "auto";
  /** Local name the page calls → name in the manifest (`dashboard:threads` → `@agent/dashboard:threads`). */
  functions: Record<string, string>;
}

/** The serializable spec (function names are absolute in the manifest: `@workpool/lib:stats`). */
export interface DashboardSpec {
  label: string;
  icon: DashboardIcon;
  description?: string;
  scope: "shard" | "global";
  tabs: Array<{ id: string; label: string; blocks: DashboardBlock[] }>;
  /** Every function the spec runs, by name: the runtime's allowlist. */
  functions: Record<string, DashboardFunction>;
}

/** One entry of `manifest.dashboards` and of `GET /api/_ember/dashboards`. */
export interface DashboardManifest extends DashboardSpec {
  /** `""` for the app's own screens; the install key (`workpool`, `email/rateLimit`) for a component. */
  key: string;
  /** The component's definition name (`workpool`); null for the app. */
  component: string | null;
}

// ------------------------------------------------------------------------------------------------ validation

const ID = /^[a-z][A-Za-z0-9_-]{0,39}$/;
/** A dot path into a value; `""` is the value itself (a query that returns a number). */
const PATH = /^(?:[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*)?$/;
const MAX_TABS = 20;
const MAX_BLOCKS = 30;
const MAX_ITEMS = 50;
export const DASHBOARD_PAGE_MAX = 200;
/** Bounds of an embed's fixed height, in pixels. */
export const DASHBOARD_EMBED_HEIGHT = { min: 40, max: 4000 } as const;
/**
 * An embed's route: a plain path (no scheme, host, query, fragment, `.`/`..` segment, `//` or percent-escape), at most
 * 200 characters.
 */
const ROUTE = /^\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]*$/;

/** Whether `route` is a path an embed block may name (the same check `resolveDashboard` runs). */
export function isDashboardEmbedRoute(route: unknown): route is string {
  return typeof route === "string" && route.length <= 200 && ROUTE.test(route) && !route.split("/").some((s) => s === "." || s === "..");
}

type Fns = ReadonlyMap<string, AnyRegisteredFunction | RegisteredHttpAction>;
type Routes = readonly Pick<HttpRoute, "path" | "pathPrefix" | "method" | "pattern">[];

class SpecError extends Error {}

/**
 * Checks a dashboard spec and serializes it. `functions` are the functions its refs may name (a component's own, or
 * the app's), by local name. Throws with the path of the first problem.
 */
export function resolveDashboard(input: unknown, functions: Fns, where: string, owner: "component" | "app" = "component", routes: Routes = []): DashboardSpec {
  try {
    return new Resolver(functions, owner, routes).spec(input);
  } catch (e) {
    if (e instanceof SpecError) throw new Error(`${where}: dashboard ${e.message}`);
    throw e;
  }
}

/** The structural part of the checks, without functions (`defineApp` runs it; `composeApp` resolves the refs). */
export function checkDashboardShape(input: unknown, where: string): void {
  try {
    new Resolver(null, "app", null).spec(input);
  } catch (e) {
    if (e instanceof SpecError) throw new Error(`${where}: dashboard ${e.message}`);
    throw e;
  }
}

/** The spec with every function name prefixed (a component's spec, composed under its install path). */
export function prefixDashboard(spec: DashboardSpec, prefix: string): DashboardSpec {
  if (!prefix) return spec;
  const p = (n: string) => prefix + n;
  const action = (a: DashboardAction): DashboardAction => ({ ...a, fn: p(a.fn) });
  const detail = <D extends DashboardDetail>(d: D): D => ({ ...d, query: p(d.query) });
  const block = (b: DashboardBlock): DashboardBlock => {
    switch (b.kind) {
      case "stats":
        return { ...b, query: p(b.query) };
      case "table":
        return {
          ...b,
          query: p(b.query),
          columns: b.columns.map((c) => (c.toggle ? { ...c, toggle: { ...c.toggle, mutation: p(c.toggle.mutation) } } : c)),
          ...(b.detail ? { detail: detail(b.detail) } : {}),
          ...(b.rowActions ? { rowActions: b.rowActions.map(action) } : {}),
        };
      case "detail":
        return detail(b);
      case "toggle":
        return { ...b, query: p(b.query), mutation: p(b.mutation) };
      case "actions":
        return { ...b, actions: b.actions.map(action) };
      case "embed":
        return { ...b, functions: Object.fromEntries(Object.entries(b.functions).map(([k, n]) => [k, p(n)])) };
    }
  };
  return {
    ...spec,
    tabs: spec.tabs.map((t) => ({ ...t, blocks: t.blocks.map(block) })),
    functions: Object.fromEntries(Object.entries(spec.functions).map(([n, f]) => [p(n), f])),
  };
}

/**
 * The spec with each embed's `path`: where its route is served once the component is mounted at `httpPrefix` (`/` for
 * the app's own routes), joined the way `composeApp` mounts the component's routes.
 */
export function mountDashboard(spec: DashboardSpec, httpPrefix: string): DashboardSpec {
  const join = (r: string) => (httpPrefix === "/" ? r : r === "/" ? httpPrefix : httpPrefix + r);
  return { ...spec, tabs: spec.tabs.map((t) => ({ ...t, blocks: t.blocks.map((b) => (b.kind === "embed" ? { ...b, path: join(b.route) } : b)) })) };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Plain JSON (what the manifest can carry): no functions, symbols, class instances or non-finite numbers. */
function plainJson(x: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (x === null || typeof x === "string" || typeof x === "boolean") return true;
  if (typeof x === "number") return Number.isFinite(x);
  if (Array.isArray(x)) return x.every((v) => plainJson(v, depth + 1));
  if (typeof x === "object") {
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(x as Record<string, unknown>).every((v) => plainJson(v, depth + 1));
  }
  return false;
}

class Resolver {
  private readonly used = new Map<string, DashboardFunction>();
  private scope: "shard" | "global" = "shard";
  constructor(
    private readonly fns: Fns | null,
    private readonly owner: "component" | "app",
    /** The owner's HTTP routes (as declared, before mounting); null in the shape-only check. */
    private readonly routes: Routes | null,
  ) {}

  spec(input: unknown): DashboardSpec {
    const s = this.object(input, "", ["label", "icon", "description", "scope", "tabs"]);
    const label = this.label(s.label, "label");
    const icon = s.icon === undefined ? "box" : s.icon;
    if (!(DASHBOARD_ICONS as readonly unknown[]).includes(icon)) throw new SpecError(`icon ${JSON.stringify(icon)}: one of ${DASHBOARD_ICONS.join(", ")}`);
    const scope = s.scope === undefined ? "shard" : s.scope;
    if (scope !== "shard" && scope !== "global") throw new SpecError(`scope must be "shard" or "global"`);
    this.scope = scope;
    const tabs = this.list(s.tabs, "tabs", MAX_TABS, true);
    const tabIds = new Set<string>();
    const out: DashboardSpec = {
      label,
      icon: icon as DashboardIcon,
      ...(s.description !== undefined ? { description: this.text(s.description, "description") } : {}),
      scope,
      tabs: tabs.map((t, i) => {
        const at = `tabs[${i}]`;
        const tab = this.object(t, at, ["id", "label", "blocks"]);
        const id = this.id(tab.id, `${at}.id`);
        if (tabIds.has(id)) throw new SpecError(`${at}.id ${JSON.stringify(id)} is used twice`);
        tabIds.add(id);
        const blockIds = new Set<string>();
        return {
          id,
          label: this.label(tab.label, `${at}.label`),
          blocks: this.list(tab.blocks, `${at}.blocks`, MAX_BLOCKS, true).map((b, j) => {
            const block = this.block(b, `${at}.blocks[${j}]`, j);
            if (blockIds.has(block.id)) throw new SpecError(`${at}.blocks[${j}].id ${JSON.stringify(block.id)} is used twice`);
            blockIds.add(block.id);
            return block;
          }),
        };
      }),
      functions: {},
    };
    out.functions = Object.fromEntries([...this.used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return out;
  }

  // ---------------------------------------------------------------------------------------- blocks

  private block(input: unknown, at: string, index: number): DashboardBlock {
    if (!isObj(input)) throw new SpecError(`${at} must be an object`);
    const base = (o: Record<string, unknown>) => ({
      id: o.id === undefined ? `b${index}` : this.id(o.id, `${at}.id`),
      ...(o.label !== undefined ? { label: this.label(o.label, `${at}.label`) } : {}),
      ...(o.description !== undefined ? { description: this.text(o.description, `${at}.description`) } : {}),
    });
    const common = ["kind", "id", "label", "description"];
    switch (input.kind) {
      case "stats": {
        const o = this.object(input, at, [...common, "query", "args", "items"]);
        const q = this.fn(o.query, `${at}.query`, ["query"]);
        return { kind: "stats", ...base(o), query: q.name, ...this.args(o.args, q, `${at}.args`), items: this.fields(o.items, `${at}.items`) };
      }
      case "table": {
        const o = this.object(input, at, [...common, "query", "args", "rows", "columns", "filters", "pageSize", "rowKey", "detail", "rowActions"]);
        const q = this.fn(o.query, `${at}.query`, ["query"]);
        const fixed = this.args(o.args, q, `${at}.args`);
        const paged = q.args ? pagination(q.args, `${at}.query`) : false;
        const argNames = q.args ? Object.keys(q.args.fields).filter((k) => k !== "paginationOpts") : [];
        let filters: string[];
        if (o.filters === undefined) filters = argNames.filter((k) => !(fixed.args && k in fixed.args));
        else {
          filters = this.list(o.filters, `${at}.filters`, MAX_ITEMS, false).map((f, i) => {
            if (typeof f !== "string") throw new SpecError(`${at}.filters[${i}] must be an argument name`);
            if (q.args && !argNames.includes(f)) throw new SpecError(`${at}.filters[${i}]: ${q.name} has no argument ${JSON.stringify(f)} (it has: ${argNames.join(", ") || "none"})`);
            return f;
          });
        }
        if (o.pageSize !== undefined && (!Number.isInteger(o.pageSize) || (o.pageSize as number) < 1 || (o.pageSize as number) > DASHBOARD_PAGE_MAX)) throw new SpecError(`${at}.pageSize must be an integer in 1..${DASHBOARD_PAGE_MAX}`);
        if (o.pageSize !== undefined && q.args && !paged) throw new SpecError(`${at}.pageSize: ${q.name} is not paginated (no paginationOpts argument)`);
        const pageSize = (o.pageSize as number | undefined) ?? 25;
        // The pager sends `numItems: pageSize`: the query's own validator must take it (a `numItems: v.number().max(10)`).
        if (paged && q.args && !validate(q.args.fields.paginationOpts!.shape, { numItems: pageSize, cursor: null }).ok) {
          throw new SpecError(`${at}.pageSize: ${q.name}'s paginationOpts.numItems does not accept ${pageSize}${o.pageSize === undefined ? " (the default; set pageSize)" : ""}`);
        }
        const columns = this.list(o.columns, `${at}.columns`, MAX_ITEMS, true).map((c, i) => this.column(c, `${at}.columns[${i}]`));
        const rowActions = o.rowActions === undefined ? undefined : this.actions(o.rowActions, `${at}.rowActions`, true);
        return {
          kind: "table",
          ...base(o),
          query: q.name,
          ...fixed,
          ...(o.rows !== undefined ? { rows: this.path(o.rows, `${at}.rows`) } : {}),
          columns,
          filters,
          ...(paged ? { pageSize } : {}),
          rowKey: o.rowKey === undefined ? "_id" : this.path(o.rowKey, `${at}.rowKey`),
          ...(o.detail !== undefined ? { detail: this.detail(this.object(o.detail, `${at}.detail`, ["query", "args", "fromRow", "sections"]), `${at}.detail`, true) } : {}),
          ...(rowActions ? { rowActions } : {}),
        };
      }
      case "detail": {
        const o = this.object(input, at, [...common, "query", "args", "fromRow", "sections"]);
        if (o.fromRow !== undefined) throw new SpecError(`${at}.fromRow: only a table's detail has rows`);
        return { kind: "detail", ...base(o), ...this.detail(o, at, false) };
      }
      case "toggle": {
        const o = this.object(input, at, [...common, "query", "args", "path", "mutation", "arg", "mutationArgs"]);
        const q = this.fn(o.query, `${at}.query`, ["query"]);
        const m = this.fn(o.mutation, `${at}.mutation`, ["mutation"]);
        const arg = this.boolArg(o.arg, m, `${at}.arg`);
        const mutationArgs = this.args(o.mutationArgs, m, `${at}.mutationArgs`).args;
        return {
          kind: "toggle",
          ...base(o),
          label: this.label(o.label, `${at}.label`),
          query: q.name,
          ...this.args(o.args, q, `${at}.args`),
          path: this.path(o.path, `${at}.path`),
          mutation: m.name,
          arg,
          ...(mutationArgs ? { mutationArgs } : {}),
        };
      }
      case "actions": {
        const o = this.object(input, at, [...common, "actions"]);
        return { kind: "actions", ...base(o), actions: this.actions(o.actions, `${at}.actions`, false) };
      }
      case "embed": {
        const o = this.object(input, at, [...common, "route", "height", "functions"]);
        if (!isDashboardEmbedRoute(o.route)) throw new SpecError(`${at}.route must be a path like "/dashboard/page" (no scheme, host, query, "..", "//" or escapes)`);
        const route = o.route;
        if (this.routes) {
          const hit = matchRoute(this.routes, "GET", route);
          if (!hit || "methodMismatch" in hit) throw new SpecError(`${at}.route ${route}: not a GET route of this ${this.owner}'s http router`);
        }
        const height = o.height === undefined ? "auto" : o.height;
        if (height !== "auto" && (!Number.isInteger(height) || (height as number) < DASHBOARD_EMBED_HEIGHT.min || (height as number) > DASHBOARD_EMBED_HEIGHT.max)) {
          throw new SpecError(`${at}.height must be "auto" or an integer in ${DASHBOARD_EMBED_HEIGHT.min}..${DASHBOARD_EMBED_HEIGHT.max}`);
        }
        const functions: Record<string, string> = {};
        if (o.functions !== undefined) {
          this.list(o.functions, `${at}.functions`, MAX_ITEMS, false).forEach((ref, i) => {
            const f = this.fn(ref, `${at}.functions[${i}]`, ["query", "mutation", "action"]);
            // Local and manifest names are the same here; `prefixDashboard` prefixes the manifest side.
            if (f.name) functions[f.name] = f.name;
          });
        }
        return { kind: "embed", ...base(o), route, height: height as number | "auto", functions };
      }
      default:
        throw new SpecError(`${at}.kind ${JSON.stringify(input.kind)}: one of stats, table, detail, toggle, actions, embed`);
    }
  }

  private detail(o: Record<string, unknown>, at: string, inTable: boolean): DashboardDetail {
    const q = this.fn(o.query, `${at}.query`, ["query"]);
    const fromRow = inTable ? this.fromRow(o.fromRow, q, `${at}.fromRow`) : undefined;
    return {
      query: q.name,
      ...this.args(o.args, q, `${at}.args`),
      ...(fromRow ? { fromRow } : {}),
      sections: this.list(o.sections, `${at}.sections`, MAX_ITEMS, true).map((s, i) => this.section(s, `${at}.sections[${i}]`)),
    };
  }

  private section(input: unknown, at: string): DashboardSectionInput {
    if (!isObj(input)) throw new SpecError(`${at} must be an object`);
    const label = (o: Record<string, unknown>) => (o.label !== undefined ? { label: this.label(o.label, `${at}.label`) } : {});
    switch (input.kind) {
      case "kv": {
        const o = this.object(input, at, ["kind", "label", "path", "items"]);
        return { kind: "kv", ...label(o), ...(o.path !== undefined ? { path: this.path(o.path, `${at}.path`) } : {}), items: this.fields(o.items, `${at}.items`) };
      }
      case "timeline": {
        const o = this.object(input, at, ["kind", "label", "path", "time", "title", "detail", "status"]);
        return {
          kind: "timeline",
          ...label(o),
          path: this.path(o.path, `${at}.path`),
          time: this.path(o.time, `${at}.time`),
          title: this.path(o.title, `${at}.title`),
          ...(o.detail !== undefined ? { detail: this.path(o.detail, `${at}.detail`) } : {}),
          ...(o.status !== undefined ? { status: this.path(o.status, `${at}.status`) } : {}),
        };
      }
      case "code": {
        const o = this.object(input, at, ["kind", "label", "path", "language"]);
        return { kind: "code", ...label(o), path: this.path(o.path, `${at}.path`), ...(o.language !== undefined ? { language: this.id(o.language, `${at}.language`) } : {}) };
      }
      case "stacktrace": {
        const o = this.object(input, at, ["kind", "label", "path"]);
        return { kind: "stacktrace", ...label(o), path: this.path(o.path, `${at}.path`) };
      }
      case "json": {
        const o = this.object(input, at, ["kind", "label", "path"]);
        return { kind: "json", ...label(o), ...(o.path !== undefined ? { path: this.path(o.path, `${at}.path`) } : {}) };
      }
      case "chart": {
        const o = this.object(input, at, ["kind", "label", "path", "x", "y", "type"]);
        if (o.type !== undefined && o.type !== "line" && o.type !== "bar") throw new SpecError(`${at}.type must be "line" or "bar"`);
        const y = this.list(o.y, `${at}.y`, 6, true).map((p, i) => this.path(p, `${at}.y[${i}]`));
        return { kind: "chart", ...label(o), path: this.path(o.path, `${at}.path`), x: this.path(o.x, `${at}.x`), y, ...(o.type !== undefined ? { type: o.type } : {}) };
      }
      default:
        throw new SpecError(`${at}.kind ${JSON.stringify(input.kind)}: one of kv, timeline, code, stacktrace, json, chart`);
    }
  }

  private column(input: unknown, at: string): DashboardColumnSpec {
    const o = this.object(input, at, ["label", "path", "format", "toggle"]);
    const field = this.field(o, at);
    if (o.toggle === undefined) return field;
    const t = this.object(o.toggle, `${at}.toggle`, ["mutation", "arg", "args", "fromRow"]);
    const m = this.fn(t.mutation, `${at}.toggle.mutation`, ["mutation"]);
    const arg = this.boolArg(t.arg, m, `${at}.toggle.arg`);
    const args = this.args(t.args, m, `${at}.toggle.args`).args;
    const fromRow = this.fromRow(t.fromRow, m, `${at}.toggle.fromRow`);
    return { ...field, toggle: { mutation: m.name, arg, ...(args ? { args } : {}), ...(fromRow ? { fromRow } : {}) } };
  }

  private actions(input: unknown, at: string, inTable: boolean): DashboardAction[] {
    const ids = new Set<string>();
    return this.list(input, at, MAX_ITEMS, true).map((a, i) => {
      const where = `${at}[${i}]`;
      const o = this.object(a, where, ["id", "label", "fn", "args", "fromRow", "description", "destructive"]);
      const id = o.id === undefined ? `a${i}` : this.id(o.id, `${where}.id`);
      if (ids.has(id)) throw new SpecError(`${where}.id ${JSON.stringify(id)} is used twice`);
      ids.add(id);
      if (o.destructive !== undefined && typeof o.destructive !== "boolean") throw new SpecError(`${where}.destructive must be a boolean`);
      if (!inTable && o.fromRow !== undefined) throw new SpecError(`${where}.fromRow: only a table's rowActions have rows`);
      const f = this.fn(o.fn, `${where}.fn`, ["mutation", "action"]);
      // `fn` recorded it (absent only in the shape-only check, which names no function).
      const entry = this.used.get(f.name);
      if (o.destructive === true && entry) entry.destructive = true;
      const fromRow = this.fromRow(o.fromRow, f, `${where}.fromRow`);
      return {
        id,
        label: this.label(o.label, `${where}.label`),
        fn: f.name,
        ...this.args(o.args, f, `${where}.args`),
        ...(fromRow ? { fromRow } : {}),
        ...(o.description !== undefined ? { description: this.text(o.description, `${where}.description`) } : {}),
        ...(o.destructive === true ? { destructive: true as const } : {}),
      };
    });
  }

  // ---------------------------------------------------------------------------------------- functions and args

  /** A ref → its name and args shape (null args when only the shape is checked: `checkDashboardShape`). */
  private fn(ref: unknown, at: string, kinds: readonly ("query" | "mutation" | "action")[]): { name: string; args: ObjectShape | null } {
    if (typeof ref === "string") throw new SpecError(`${at}: a function reference (functions.lib.fn, internal.mod.fn), not a string`);
    if (!isObj(ref) && typeof ref !== "function") throw new SpecError(`${at}: expected a function reference`);
    if (!this.fns) {
      if (!isRegisteredFunction(ref)) {
        try {
          getFunctionName(ref as never);
        } catch {
          throw new SpecError(`${at}: expected a function reference`);
        }
      }
      return { name: "", args: null };
    }
    let name: string | undefined;
    let f: AnyRegisteredFunction | RegisteredHttpAction | undefined;
    if (isRegisteredFunction(ref)) {
      for (const [n, x] of this.fns) {
        if (x === ref) {
          name = n;
          f = x;
          break;
        }
      }
      if (!name) throw new SpecError(`${at}: that function is not one of this ${this.owner}'s functions (pass one of its own, or a reference like internal.mod.fn)`);
    } else {
      try {
        name = getFunctionName(ref as never);
      } catch {
        throw new SpecError(`${at}: expected a function reference`);
      }
      f = this.fns.get(name);
      if (!f) throw new SpecError(`${at}: ${name} is not a function of this ${this.owner}`);
    }
    if (f!.type === "httpAction" || !kinds.includes(f!.type)) throw new SpecError(`${at}: ${name} is a ${f!.type}, expected a ${kinds.join(" or ")}`);
    const reg = f as AnyRegisteredFunction;
    // A global screen runs everything on global:main: a function pinned to another kind of shard would refuse to run.
    if (this.scope === "global" && reg.shard && reg.shard.kind !== "global") throw new SpecError(`${at}: ${name} runs in "${reg.shard.kind}" shards, but a scope "global" screen runs on global:main`);
    const prev = this.used.get(name);
    this.used.set(name, { type: reg.type as DashboardFunction["type"], args: reg.args, ...(prev?.destructive ? { destructive: true as const } : {}) });
    return { name, args: reg.args };
  }

  /** Fixed args: known arguments with values their validators accept. */
  private args(input: unknown, f: { name: string; args: ObjectShape | null }, at: string): { args?: Record<string, unknown> } {
    if (input === undefined) return {};
    if (!isObj(input)) throw new SpecError(`${at} must be an object`);
    if (!plainJson(input)) throw new SpecError(`${at} must be plain JSON (no functions, dates or class instances)`);
    if (f.args) {
      for (const [k, value] of Object.entries(input)) {
        const field = f.args.fields[k];
        if (!field) throw new SpecError(`${at}.${k}: ${f.name} has no argument ${JSON.stringify(k)} (it has: ${Object.keys(f.args.fields).join(", ") || "none"})`);
        const r = validate(field.shape, value);
        if (!r.ok) throw new SpecError(`${at}.${k}: ${r.message}${r.path ? ` at ${r.path}` : ""} (does not fit ${f.name}'s validator)`);
      }
    }
    return Object.keys(input).length ? { args: { ...input } } : {};
  }

  private fromRow(input: unknown, f: { name: string; args: ObjectShape | null }, at: string): Record<string, string> | undefined {
    if (input === undefined) return undefined;
    if (!isObj(input)) throw new SpecError(`${at} must be an object { <argument>: "<path in the row>" }`);
    const out: Record<string, string> = {};
    for (const [k, p] of Object.entries(input)) {
      if (f.args && !f.args.fields[k]) throw new SpecError(`${at}.${k}: ${f.name} has no argument ${JSON.stringify(k)}`);
      out[k] = this.path(p, `${at}.${k}`);
    }
    return Object.keys(out).length ? out : undefined;
  }

  private boolArg(input: unknown, f: { name: string; args: ObjectShape | null }, at: string): string {
    if (typeof input !== "string" || !input) throw new SpecError(`${at} must name a boolean argument`);
    if (f.args) {
      const field: FieldShape | undefined = f.args.fields[input];
      if (!field) throw new SpecError(`${at}: ${f.name} has no argument ${JSON.stringify(input)}`);
      if (!acceptsBoolean(field.shape)) throw new SpecError(`${at}: ${f.name}'s ${input} is not a v.boolean()`);
    }
    return input;
  }

  // ---------------------------------------------------------------------------------------- primitives

  private object(input: unknown, at: string, keys: string[]): Record<string, unknown> {
    if (!isObj(input)) throw new SpecError(`${at || "spec"} must be an object`);
    for (const k of Object.keys(input)) if (!keys.includes(k)) throw new SpecError(`${at ? `${at}.` : ""}${k}: unknown key (known: ${keys.join(", ")})`);
    return input;
  }

  private list(input: unknown, at: string, max: number, nonEmpty: boolean): unknown[] {
    if (!Array.isArray(input)) throw new SpecError(`${at} must be an array`);
    if (nonEmpty && !input.length) throw new SpecError(`${at} is empty`);
    if (input.length > max) throw new SpecError(`${at}: at most ${max}`);
    // A sparse array (`new Array(1)`): `map` would skip the hole and the manifest would carry a null.
    for (let i = 0; i < input.length; i++) if (!Object.hasOwn(input, i)) throw new SpecError(`${at}[${i}] is missing (a sparse array)`);
    return input;
  }

  private fields(input: unknown, at: string): DashboardField[] {
    return this.list(input, at, MAX_ITEMS, true).map((x, i) => this.field(this.object(x, `${at}[${i}]`, ["label", "path", "format"]), `${at}[${i}]`));
  }

  private field(o: Record<string, unknown>, at: string): DashboardField {
    if (o.format !== undefined && !(DASHBOARD_FORMATS as readonly unknown[]).includes(o.format)) throw new SpecError(`${at}.format ${JSON.stringify(o.format)}: one of ${DASHBOARD_FORMATS.join(", ")}`);
    return { label: this.label(o.label, `${at}.label`), path: this.path(o.path, `${at}.path`), ...(o.format !== undefined ? { format: o.format as DashboardFormat } : {}) };
  }

  private id(x: unknown, at: string): string {
    if (typeof x !== "string" || !ID.test(x)) throw new SpecError(`${at} must match ${ID.source}`);
    return x;
  }

  private label(x: unknown, at: string): string {
    if (typeof x !== "string" || !x.trim() || x.length > 80) throw new SpecError(`${at} must be a non-empty string (at most 80 characters)`);
    return x;
  }

  private text(x: unknown, at: string): string {
    if (typeof x !== "string" || x.length > 500) throw new SpecError(`${at} must be a string (at most 500 characters)`);
    return x;
  }

  private path(x: unknown, at: string): string {
    if (typeof x !== "string" || x.length > 200 || !PATH.test(x)) throw new SpecError(`${at} must be a dot path like "totals.enqueued"`);
    return x;
  }
}

function acceptsBoolean(s: Shape): boolean {
  return s.kind === "boolean" || (s.kind === "union" && s.members.some(acceptsBoolean));
}

/**
 * A paginated query: `paginationOpts` is `{ numItems, cursor }` (`paginationOptsValidator`). The pager sends
 * `{ numItems: <pageSize>, cursor: null }` and then the string `continueCursor`: its cursor field must take both (the
 * page size, checked against `numItems` with the table's own `pageSize`, is the caller's: a bound on it is not a shape
 * error).
 */
function pagination(args: ObjectShape, at: string): boolean {
  const p = args.fields.paginationOpts;
  if (!p) return false;
  const s = p.shape;
  const cursor = s.kind === "object" ? s.fields.cursor : undefined;
  const fits = (c: string | null) => !!cursor && validate(cursor.shape, c).ok;
  if (s.kind !== "object" || s.fields.numItems?.shape.kind !== "number" || !cursor || !fits(null) || !fits("c")) {
    throw new SpecError(`${at}: its paginationOpts argument must be paginationOptsValidator ({ numItems: v.number(), cursor: v.nullable(v.string()) })`);
  }
  return true;
}
