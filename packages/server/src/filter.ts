// `.filter(q => ...)` expressions: built as data (FilterExpr), evaluated in JS with the index value order, so
// execution and invalidation share one semantics.

import { compareValues } from "@freecorps/ember-values";
import { fieldOf } from "./layout.ts";
import type { FilterExpr } from "./types.ts";

const TAG = Symbol.for("ember.filterExpr");
type Tagged = FilterExpr & { [TAG]: true };

const node = (e: FilterExpr): Tagged => Object.assign(e, { [TAG]: true as const });
const isExpr = (x: unknown): x is Tagged => typeof x === "object" && x !== null && (x as Tagged)[TAG] === true;
const strip = (x: Tagged): FilterExpr => {
  const { [TAG]: _t, ...rest } = x;
  if ("args" in rest) return { op: rest.op, args: rest.args };
  return rest as FilterExpr;
};
export const toExpr = (x: unknown): FilterExpr => (isExpr(x) ? strip(x) : { literal: x });

const binary =
  (op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte") =>
  (l: unknown, r: unknown): Tagged =>
    node({ op, args: [toExpr(l), toExpr(r)] });

/** The runtime filter builder handed to `.filter()`. */
export const filterBuilder = {
  field: (path: string) => node({ field: path }),
  eq: binary("eq"),
  neq: binary("neq"),
  lt: binary("lt"),
  lte: binary("lte"),
  gt: binary("gt"),
  gte: binary("gte"),
  and: (...e: unknown[]) => node({ op: "and", args: e.map(toExpr) }),
  or: (...e: unknown[]) => node({ op: "or", args: e.map(toExpr) }),
  not: (e: unknown) => node({ op: "not", args: [toExpr(e)] }),
};

export function evalExpr(e: FilterExpr, doc: Record<string, unknown>): unknown {
  if ("field" in e) return fieldOf(doc, e.field);
  if ("literal" in e) return e.literal;
  switch (e.op) {
    case "and":
      return e.args.every((x) => evalExpr(x, doc) === true);
    case "or":
      return e.args.some((x) => evalExpr(x, doc) === true);
    case "not":
      return evalExpr(e.args[0]!, doc) !== true;
  }
  const c = compareValues(evalExpr(e.args[0]!, doc), evalExpr(e.args[1]!, doc));
  switch (e.op) {
    case "eq":
      return c === 0;
    case "neq":
      return c !== 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
  }
}

// `passes` runs per scanned row and per change of a subscription's range: each expression is compiled once into
// closures (cached by identity; expressions are never changed after they are built), with `evalExpr`'s semantics.
type Compiled = (doc: Record<string, unknown>) => unknown;
const compiledExprs = new WeakMap<FilterExpr, Compiled>();

function compiledExpr(e: FilterExpr): Compiled {
  let c = compiledExprs.get(e);
  if (!c) compiledExprs.set(e, (c = compileExpr(e)));
  return c;
}

const COMPARE: Record<string, (c: number) => boolean> = {
  eq: (c) => c === 0,
  neq: (c) => c !== 0,
  lt: (c) => c < 0,
  lte: (c) => c <= 0,
  gt: (c) => c > 0,
  gte: (c) => c >= 0,
};

function compileExpr(e: FilterExpr): Compiled {
  if ("field" in e) {
    const path = e.field;
    if (typeof path === "string" && !path.includes(".")) return (doc) => doc[path];
    return (doc) => fieldOf(doc, path);
  }
  if ("literal" in e) return () => e.literal;
  const args = (e as { args?: unknown }).args;
  // Anything malformed is left to the interpreter (same result, same errors).
  if (!Array.isArray(args) || !args.every((a) => typeof a === "object" && a !== null)) return (doc) => evalExpr(e, doc);
  const parts = (args as FilterExpr[]).map(compiledExpr);
  switch (e.op) {
    case "and":
      return (doc) => {
        for (let i = 0; i < parts.length; i++) if (parts[i]!(doc) !== true) return false;
        return true;
      };
    case "or":
      return (doc) => {
        for (let i = 0; i < parts.length; i++) if (parts[i]!(doc) === true) return true;
        return false;
      };
    case "not": {
      const [a] = parts;
      if (!a) return (doc) => evalExpr(e, doc);
      return (doc) => a(doc) !== true;
    }
  }
  const test = Object.prototype.hasOwnProperty.call(COMPARE, e.op) ? COMPARE[e.op]! : undefined;
  const [l, r] = parts;
  if (!l || !r) return (doc) => evalExpr(e, doc);
  if (!test) {
    // An unknown operator: compares, then answers undefined (as `evalExpr`).
    return (doc) => {
      compareValues(l(doc), r(doc));
      return undefined;
    };
  }
  return (doc) => test(compareValues(l(doc), r(doc)));
}

export const passes = (e: FilterExpr | undefined, doc: Record<string, unknown>): boolean => e === undefined || compiledExpr(e)(doc) === true;

export const andAll = (es: FilterExpr[]): FilterExpr | undefined => (es.length === 0 ? undefined : es.length === 1 ? es[0] : { op: "and", args: es });
