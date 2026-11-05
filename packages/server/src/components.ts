// Components (PLAN §12, contracts.md "Componentes"): packaged features with their own tables, functions, config,
// scheduled jobs and HTTP routes, installed by an app with `defineApp().use(component, { name?, config? })`.
//
// Ember composes an app and its components into ONE schema and ONE function map before the engine sees them:
// - a component installed as `rl` owns physical tables `rl$<table>` (nested: `email$rl$<table>`), ids
//   `rl$<prefix>_<ULID>`; v.id() shapes inside its documents are rewritten to the physical names;
// - its functions are named `@rl/<module>:<fn>` (nested: `@email/@rl/<module>:<fn>`).
// So migrations, staged indexes, the shard catalog, reactivity and the scheduler work unchanged: a component's
// tables live in every shard, next to the app's, and a call runs in the caller's shard and transaction.
//
// Isolation is enforced by scopes (the leading `@x/` segments of a function name): `ctx.db` of a function only
// sees its scope's tables (by their logical names), references resolve relative to the caller's scope, and the
// parent may only call the public functions of its direct children. Clients never reach component functions.

import { toJSONValue, validate, type GenericValidator, type Infer, type ObjectShape, type Shape } from "@freecorps/ember-values";
import { EmberError } from "./errors.ts";
import {
  flattenFunctions,
  getFunctionName,
  IS_FUNCTION,
  type AnyFunctionReference,
  type AnyRegisteredFunction,
  type ApiFromModules,
  type FilterApi,
  type FunctionReference,
  type FunctionType,
  type RegisteredHttpAction,
} from "./functions.ts";
import type { IndexKind } from "./indexKinds.ts";
import { canonicalJson, manifestHash, SchemaDefinition, type SchemaManifest, type TableManifest } from "./schema.ts";
import { assertNotReserved, type HttpRouter, type HttpRoute } from "./http.ts";

/** Separator of physical table names: `<component>$<table>`. Never valid in an app table name. */
export const TABLE_SEP = "$";
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const IS_COMPONENT = Symbol.for("ember.component");
export const IS_APP = Symbol.for("ember.app");

// ------------------------------------------------------------------------------------------------ definitions

export interface InstallOptions<Config> {
  /** Install name (default: the component's name). Becomes the table namespace and the `components.<name>` key. */
  name?: string;
  /** Validated against the component's `config` validator; available as `ctx.component.config`. */
  config?: Config;
  /** Where the component's HTTP routes are mounted (default `/<name>`). */
  httpPrefix?: string;
}

export interface Installed {
  readonly name: string;
  readonly component: AnyComponentDefinition;
  readonly config: unknown;
  readonly httpPrefix: string;
}

/** A Cloudflare binding a component needs (provisioned by `ember deploy`); see contracts.md. */
export type ComponentBinding = { type: "ratelimit"; name: string; limit: number; period: 10 | 60 };

export interface ComponentDefinition<
  Name extends string = string,
  Modules extends Record<string, object> = Record<string, object>,
  Config = unknown,
  Children extends Record<string, AnyComponentDefinition> = {},
> {
  readonly [IS_COMPONENT]: true;
  readonly name: Name;
  readonly schema: SchemaDefinition<any, any> | undefined;
  /** `{ "<module>": { fn } }`, the same shape as an app's modules. */
  readonly functions: Modules;
  readonly config: GenericValidator | undefined;
  readonly http: HttpRouter | undefined;
  /** Bindings the component wants for an install config (e.g. a Rate Limiting binding). */
  readonly bindings: ((config: Config, installName: string) => ComponentBinding[]) | undefined;
  readonly children: readonly Installed[];
  /** Installs a child component (nested: its tables are `<this>$<child>$<table>`). */
  use<C extends AnyComponentDefinition, const N extends string = C["name"]>(
    child: C,
    opts?: InstallOptions<ConfigOf<C>> & { name?: N },
  ): ComponentDefinition<Name, Modules, Config, Children & Record<N, C>>;
  /** Phantom. */
  readonly __children?: Children;
}
export type AnyComponentDefinition = ComponentDefinition<string, any, any, any>;
export type ConfigOf<C> = C extends ComponentDefinition<any, any, infer Cfg, any> ? Cfg : never;

export interface DefineComponentOptions<Name extends string, Modules extends Record<string, object>, CV extends GenericValidator | undefined> {
  name: Name;
  schema?: SchemaDefinition<any, any>;
  /** Function modules: `{ lib: { limit, reset } }` (or a flat `{ "lib:limit": fn }`). */
  functions: Modules;
  /** Validator of the install-time config (`app.use(c, { config })`). */
  config?: CV;
  http?: HttpRouter;
  bindings?: (config: CV extends GenericValidator ? Infer<CV> : undefined, installName: string) => ComponentBinding[];
}

function checkName(what: string, name: string) {
  if (typeof name !== "string" || !NAME.test(name) || name.includes("__")) {
    throw new Error(`${what} ${JSON.stringify(name)}: use [A-Za-z][A-Za-z0-9_]* (max 40, no "__")`);
  }
}

function makeComponent(def: Omit<AnyComponentDefinition, typeof IS_COMPONENT | "use" | "__children">): AnyComponentDefinition {
  const self: AnyComponentDefinition = Object.freeze({
    [IS_COMPONENT]: true as const,
    ...def,
    use(child: AnyComponentDefinition, opts: InstallOptions<unknown> = {}) {
      return makeComponent({ ...def, children: [...def.children, install(child, opts, def.children)] });
    },
  });
  return self;
}

export function defineComponent<const Name extends string, Modules extends Record<string, object>, CV extends GenericValidator | undefined = undefined>(
  def: DefineComponentOptions<Name, Modules, CV>,
): ComponentDefinition<Name, Modules, CV extends GenericValidator ? Infer<CV> : undefined, {}> {
  checkName("Component name", def.name);
  if (def.schema && !(def.schema instanceof SchemaDefinition)) throw new Error(`Component ${def.name}: schema must be a defineSchema() result`);
  if (def.schema && Object.keys(def.schema.manifest.shards).length) {
    throw new Error(`Component ${def.name}: components cannot declare shards (their tables live in the caller's shard)`);
  }
  if (def.schema) {
    for (const [t, m] of Object.entries(def.schema.manifest.tables)) {
      if (m.shard) throw new Error(`Component ${def.name}: table ${t} cannot use .shard() (component tables live in the caller's shard)`);
    }
  }
  return makeComponent({
    name: def.name,
    schema: def.schema,
    functions: def.functions ?? {},
    config: def.config,
    http: def.http,
    bindings: def.bindings as AnyComponentDefinition["bindings"],
    children: [],
  }) as any;
}

function install(c: AnyComponentDefinition, opts: InstallOptions<unknown>, siblings: readonly Installed[]): Installed {
  if (!c || (c as any)[IS_COMPONENT] !== true) throw new Error("use(): expected a defineComponent() result");
  const name = opts.name ?? c.name;
  checkName("Component install name", name);
  if (siblings.some((s) => s.name === name)) throw new Error(`Component name ${name} is installed twice (pass { name } to install it again)`);
  let config: unknown = opts.config;
  if (c.config) {
    const r = validate(c.config.shape, config, {});
    if (!r.ok) throw new Error(`Component ${name}: invalid config: ${r.path}: ${r.message}`);
  } else if (config !== undefined) throw new Error(`Component ${name} takes no config`);
  const httpPrefix = normalizePrefix(opts.httpPrefix ?? `/${name}`);
  return Object.freeze({ name, component: c, config, httpPrefix });
}

function normalizePrefix(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`httpPrefix must start with "/" (got ${JSON.stringify(p)})`);
  return p.replace(/\/+$/, "") || "/";
}

export interface AppDefinition<Components extends Record<string, AnyComponentDefinition> = {}> {
  readonly [IS_APP]: true;
  readonly components: readonly Installed[];
  use<C extends AnyComponentDefinition, const N extends string = C["name"]>(
    component: C,
    opts?: InstallOptions<ConfigOf<C>> & { name?: N },
  ): AppDefinition<Components & Record<N, C>>;
  /** Phantom. */
  readonly __components?: Components;
}

/** `ember/ember.config.ts`: `export default defineApp().use(rateLimit, { config: {...} })`. */
export function defineApp(): AppDefinition<{}> {
  const make = (components: readonly Installed[]): AppDefinition<any> =>
    Object.freeze({
      [IS_APP]: true as const,
      components,
      use(c: AnyComponentDefinition, opts: InstallOptions<unknown> = {}) {
        return make([...components, install(c, opts, components)]);
      },
    });
  return make([]);
}

export const isAppDefinition = (x: unknown): x is AppDefinition<any> => typeof x === "object" && x !== null && (x as any)[IS_APP] === true;

// ------------------------------------------------------------------------------------------------ typed refs

/** Public functions of a component, as references (what the parent may call). */
export type ComponentApi<C> = C extends ComponentDefinition<any, infer M, any, any> ? FilterApi<ApiFromModules<M>, "public"> : never;
/** `components.<installName>.<module>.<fn>` for an app (or a component's children). */
export type ComponentsApi<A> =
  A extends AppDefinition<infer Cs>
    ? { [K in keyof Cs]: ComponentApi<Cs[K]> }
    : A extends ComponentDefinition<any, any, any, infer Ch>
      ? { [K in keyof Ch]: ComponentApi<Ch[K]> }
      : never;

/** Runtime `components`: `components.rl.lib.limit` is a reference to "@rl/lib:limit". */
function createComponentsProxy(path: string[] = []): any {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === FUNCTION_NAME_SYMBOL) {
          if (path.length < 3) throw new Error(`Expected components.<name>.<module>.<function>, got components.${path.join(".")}`);
          return `@${path[0]}/${path.slice(1, -1).join("/")}:${path[path.length - 1]}`;
        }
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
        return createComponentsProxy([...path, prop]);
      },
    },
  );
}
const FUNCTION_NAME_SYMBOL = Symbol.for("ember.functionName");
/** Untyped `components` (codegen re-exports it typed as `ComponentsApi<typeof app>`). */
export const anyComponents: any = createComponentsProxy();
/** Typed `components` for an app or component definition (for code that does not use codegen). */
export function componentsOf<A extends AppDefinition<any> | AnyComponentDefinition>(_def?: A): ComponentsApi<A> {
  return anyComponents;
}

/**
 * A handle to a function, usable from any scope: pass it to a component (callbacks, workflow steps) and the
 * component can call or schedule it with `ctx.runMutation(handle, args)` / `ctx.scheduler.runAfter(0, handle)`.
 * Create it in the app (root scope) from an `api`/`internal` reference.
 */
export type FunctionHandle<Type extends FunctionType = FunctionType, Args = any, Ret = any> = string & FunctionReference<Type, "internal", Args, Ret>;
export function createFunctionHandle<F extends AnyFunctionReference>(ref: F | string): FunctionHandle<F["_type"], F["_args"], F["_returnType"]> {
  const name = getFunctionName(ref as AnyFunctionReference);
  if (name.startsWith("&")) return name as any;
  return `&${name}` as any;
}

// ------------------------------------------------------------------------------------------------ scopes

/** A component scope: `path` [] is the app. */
export interface Scope {
  readonly path: readonly string[];
  /** `@a/@b/` ("" for the app). */
  readonly prefix: string;
  /** `a/b` ("" for the app): the key in `manifest.components`. */
  readonly key: string;
  /** logical -> physical table name. */
  readonly tables: ReadonlyMap<string, string>;
  /** physical -> logical. */
  readonly logical: ReadonlyMap<string, string>;
  /** Install config (undefined for the app). */
  readonly config: unknown;
  /** Install name of the innermost component ("" for the app). */
  readonly name: string;
}

export type ComponentManifest = {
  /** The component's definition name (e.g. "rateLimit"). */
  component: string;
  /** logical -> physical tables. */
  tables: Record<string, string>;
  /** Where its HTTP routes are mounted. */
  httpPrefix: string;
  /** Bindings it asked for (deploy provisions them). */
  bindings?: ComponentBinding[];
};

/** Splits `@a/@b/mod:fn` into its scope path (["a", "b"]) and the rest ("mod:fn"). */
export function splitFunctionName(name: string): { path: string[]; local: string } {
  const path: string[] = [];
  let rest = name;
  while (rest.startsWith("@")) {
    const i = rest.indexOf("/");
    if (i < 0) break;
    path.push(rest.slice(1, i));
    rest = rest.slice(i + 1);
  }
  return { path, local: rest };
}

export const scopePrefix = (path: readonly string[]) => path.map((p) => `@${p}/`).join("");

export type ResolvedRef = { name: string; via: "own" | "child" | "handle" };

/**
 * Resolves a reference from the scope `from`: `&<abs>` is a handle (absolute); `@child/mod:fn` is a direct child's
 * function; anything else is the caller's own scope. Throws FunctionNotFound for grandchildren.
 */
export function resolveReference(from: readonly string[], ref: AnyFunctionReference | string): ResolvedRef {
  const raw = getFunctionName(ref as AnyFunctionReference);
  if (raw.startsWith("&")) return { name: raw.slice(1), via: "handle" };
  const prefix = scopePrefix(from);
  if (raw.startsWith("@")) {
    const { path } = splitFunctionName(raw);
    if (path.length !== 1) throw new EmberError("FunctionNotFound", `Function ${raw} not found (only direct child components are reachable)`);
    return { name: prefix + raw, via: "child" };
  }
  return { name: prefix + raw, via: "own" };
}

/** Everything the engine and runtime need about an app's components; cached per schema. */
export class ComponentScopes {
  readonly root: Scope;
  private readonly byKey = new Map<string, Scope>();
  private readonly prefixToTable = new Map<string, string>();

  constructor(manifest: SchemaManifest, configs: ReadonlyMap<string, unknown> = new Map()) {
    const rootTables = new Map<string, string>();
    for (const t of Object.keys(manifest.tables)) if (!t.includes(TABLE_SEP)) rootTables.set(t, t);
    this.root = scope([], rootTables, undefined);
    this.byKey.set("", this.root);
    for (const [key, c] of Object.entries(manifest.components ?? {})) {
      const path = key.split("/");
      this.byKey.set(key, scope(path, new Map(Object.entries(c.tables)), configs.get(key)));
    }
    for (const [name, t] of Object.entries(manifest.tables)) this.prefixToTable.set(t.idPrefix, name);
  }

  get hasComponents(): boolean {
    return this.byKey.size > 1;
  }

  scope(path: readonly string[]): Scope | undefined {
    return this.byKey.get(path.join("/"));
  }

  /** The scope a function runs in (from its name); undefined if the component is not installed. */
  scopeOfFunction(name: string): Scope | undefined {
    return this.scope(splitFunctionName(name).path);
  }

  /** Physical table of an id (any scope). */
  physicalTableOfId(id: string): string | undefined {
    const i = typeof id === "string" ? id.lastIndexOf("_") : -1;
    return i > 0 ? this.prefixToTable.get(id.slice(0, i)) : undefined;
  }

  /** The table an id belongs to as `s` sees it: its logical name inside `s`, or the physical name otherwise. */
  tableOfIdIn(s: Scope, id: string): string | undefined {
    const t = this.physicalTableOfId(id);
    if (t === undefined) return undefined;
    return s.logical.get(t) ?? `${TABLE_SEP}${t}`;
  }
}

function scope(path: string[], tables: Map<string, string>, config: unknown): Scope {
  const logical = new Map<string, string>();
  for (const [l, p] of tables) logical.set(p, l);
  return Object.freeze({ path, prefix: scopePrefix(path), key: path.join("/"), tables, logical, config, name: path[path.length - 1] ?? "" });
}

const scopesCache = new WeakMap<object, ComponentScopes>();
/** Cached `ComponentScopes` of a schema (composed or plain). */
export function scopesOf(schema: { manifest: SchemaManifest; componentConfigs?: ReadonlyMap<string, unknown> }): ComponentScopes {
  let s = scopesCache.get(schema);
  if (!s) scopesCache.set(schema, (s = new ComponentScopes(schema.manifest, schema.componentConfigs)));
  return s;
}

/**
 * Checks that `name`, called from scope `from` through `via`, may run: a child's function must be public.
 * Returns the registered function.
 */
export function checkAccess(
  fns: ReadonlyMap<string, AnyRegisteredFunction | RegisteredHttpAction>,
  r: ResolvedRef,
): AnyRegisteredFunction | RegisteredHttpAction {
  const f = fns.get(r.name);
  if (!f || (r.via === "child" && f.type !== "httpAction" && f.visibility !== "public")) {
    throw new EmberError("FunctionNotFound", `Function ${r.name} not found`);
  }
  return f;
}

// ------------------------------------------------------------------------------------------------ composition

export interface ComposedApp {
  /** One schema: app tables + every component's tables (physical names), `manifest.components` filled. */
  schema: SchemaDefinition<any, any>;
  /** Flat `{ "mod:fn": f, "@rl/lib:limit": f }`. */
  functions: Record<string, AnyRegisteredFunction | RegisteredHttpAction>;
  /** App routes first, then each component's routes under its prefix. */
  routes: Array<HttpRoute & { scope: string[] }>;
  /** Install key ("a/b") -> config. */
  configs: Map<string, unknown>;
}

/**
 * Composes an app with its installed components (`ember/ember.config.ts`). Without components the schema is the
 * app's own (same manifest, same hash), so existing deployments are not migrated.
 */
export function composeApp(input: { schema: SchemaDefinition<any, any>; functions?: unknown; app?: AppDefinition<any> | null; http?: HttpRouter | null }): ComposedApp {
  const appFns = flattenFunctions(input.functions ?? {});
  for (const name of appFns.keys()) {
    if (name.startsWith("@") || name.startsWith("&")) throw new Error(`Function name ${name}: "@" and "&" are reserved for components and handles`);
  }
  const functions: ComposedApp["functions"] = Object.fromEntries(appFns);
  const routes: ComposedApp["routes"] = (input.http?.routes ?? []).map((r) => ({ ...r, scope: [] }));
  const configs = new Map<string, unknown>();
  const installed = input.app?.components ?? [];
  if (!installed.length) return { schema: input.schema, functions, routes, configs };

  const base = input.schema.manifest;
  const tables: Record<string, TableManifest> = { ...base.tables };
  const prefixes = new Map(Object.values(base.tables).map((t) => [t.idPrefix, true]));
  const components: Record<string, ComponentManifest> = {};
  const kinds = new Map(input.schema.indexKinds);

  const walk = (list: readonly Installed[], path: string[], mount: string) => {
    for (const inst of list) {
      const p = [...path, inst.name];
      const key = p.join("/");
      const ns = p.join(TABLE_SEP) + TABLE_SEP;
      const c = inst.component;
      const own: Record<string, string> = {};
      const m = c.schema?.manifest;
      for (const t of Object.keys(m?.tables ?? {})) own[t] = ns + t;
      for (const [t, tm] of Object.entries(m?.tables ?? {})) {
        const physical = own[t]!;
        const idPrefix = ns + tm.idPrefix;
        if (prefixes.has(idPrefix)) throw new Error(`Component ${key}: id prefix ${idPrefix} is taken`);
        prefixes.set(idPrefix, true);
        tables[physical] = { ...tm, idPrefix, document: rewriteIds(tm.document, own) as ObjectShape };
      }
      for (const [k, kind] of c.schema?.indexKinds ?? []) {
        const mine = kinds.get(k);
        if (mine && mine !== kind) throw new Error(`Component ${key}: index kind ${k} differs from the app's`);
        kinds.set(k, kind as IndexKind);
      }
      const prefix = mount === "/" ? inst.httpPrefix : mount + (inst.httpPrefix === "/" ? "" : inst.httpPrefix);
      const bindings = c.bindings?.(inst.config, key.replace(/\//g, "_")) ?? [];
      components[key] = { component: c.name, tables: own, httpPrefix: prefix, ...(bindings.length ? { bindings } : {}) };
      configs.set(key, inst.config);
      for (const [name, f] of flattenFunctions(c.functions)) {
        if (name.startsWith("@") || name.startsWith("&")) throw new Error(`Component ${key}: function name ${name} is reserved`);
        functions[scopePrefix(p) + name] = f;
      }
      for (const r of c.http?.routes ?? []) routes.push({ ...r, ...mountRoute(r, prefix), scope: p });
      walk(c.children, p, prefix);
    }
  };
  walk(installed, [], "/");

  const body: Omit<SchemaManifest, "hash" | "version"> = {
    formatVersion: 1,
    schemaValidation: base.schemaValidation,
    tables,
    shards: base.shards,
    components,
  };
  const hash = manifestHash(body);
  const manifest: SchemaManifest = Object.freeze({ version: hash, hash, ...body });
  const schema = Object.create(SchemaDefinition.prototype) as SchemaDefinition<any, any> & { componentConfigs: Map<string, unknown> };
  Object.assign(schema, { manifest, indexKinds: kinds, tables: input.schema.tables, shards: input.schema.shards, componentConfigs: configs });
  return { schema, functions, routes, configs };
}

function mountRoute(r: HttpRoute, prefix: string): Pick<HttpRoute, "path" | "pathPrefix"> {
  const join = (p: string) => (prefix === "/" ? p : p === "/" ? prefix : prefix + p);
  const out = r.path !== undefined ? { path: join(r.path) } : { pathPrefix: join(r.pathPrefix!) };
  assertNotReserved((out.path ?? out.pathPrefix)!);
  return out;
}

/** Rewrites `v.id("<logical>")` to the physical table names of the component. */
function rewriteIds(s: Shape, own: Record<string, string>): Shape {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (o.kind === "id" && typeof o.table === "string") return { ...o, table: own[o.table] ?? o.table };
      return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, walk(val)]));
    }
    return x;
  };
  return walk(toJSONValue(s as any)) as Shape;
}

/** Stable description of an app's components for tooling (codegen manifest). */
export function describeComponents(manifest: SchemaManifest): string {
  return canonicalJson(toJSONValue((manifest.components ?? {}) as any));
}

export { IS_FUNCTION };
