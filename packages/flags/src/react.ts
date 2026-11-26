// `@freecorps/ember-flags/react`: the flags a client may see, live, from the app's `forClient` query.
//
//   // ember/flags.ts (server): clients never call component functions, so the app exposes the values
//   export const forClient = query({ args: { context: vFlagContext }, handler: (ctx, a) => ff.forClient(ctx, a.context) });
//
//   // client
//   <FlagsProvider query={api.flags.forClient} args={{ context: { unitId: user.id, plan } }}>
//     <App />
//   </FlagsProvider>
//   const newCheckout = useFlag("newCheckout", false);   // `false` while loading, when missing or of another type
//
// The values come from one live query (`useQuerySnapshot` of `@freecorps/ember-react`): a flag changed in global:main
// reaches the client as soon as its shard's copy is updated. An error of the query is not thrown: every flag serves
// its default and `useFlags().error` carries it.

import { useQuerySnapshot } from "@freecorps/ember-react";
import type { FunctionReference, Visibility } from "@freecorps/ember-values";
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";

/** The app's query that returns the client-visible values (`ff.forClient(ctx, context)`). */
export type FlagsQuery<Args extends Record<string, unknown>> = FunctionReference<"query", Visibility, Args, Record<string, unknown>, never, null>;

export interface FlagsState {
  /** The values by key (undefined while loading). */
  values: Readonly<Record<string, unknown>> | undefined;
  loading: boolean;
  error: Error | undefined;
}

const EMPTY: FlagsState = { values: undefined, loading: true, error: undefined };
const FlagsContext = createContext<FlagsState | null>(null);

type LooseSnapshot = (ref: unknown, args: unknown, opts?: unknown) => { status: "loading" | "success" | "error"; value: unknown; error: unknown };

export interface FlagsProviderProps<Args extends Record<string, unknown>> {
  query: FlagsQuery<Args>;
  /** The query's args (`"skip"`: no query; every flag serves its default). */
  args: Args | "skip";
  /** The shard the query runs on (default: the client's default shard). */
  shard?: string;
  children?: ReactNode;
}

/** Runs the flags query once for the tree below; `useFlag` reads from it. */
export function FlagsProvider<Args extends Record<string, unknown>>(props: FlagsProviderProps<Args>): ReactNode {
  const snap = (useQuerySnapshot as unknown as LooseSnapshot)(props.query, props.args, props.shard === undefined ? undefined : { shard: props.shard });
  const state = useMemo(
    (): FlagsState =>
      props.args === "skip"
        ? { values: undefined, loading: false, error: undefined }
        : snap.status === "success"
          ? { values: (snap.value ?? {}) as Record<string, unknown>, loading: false, error: undefined }
          : snap.status === "error"
            ? { values: undefined, loading: false, error: snap.error instanceof Error ? snap.error : new Error(String(snap.error)) }
            : EMPTY,
    [props.args === "skip", snap.status, snap.value, snap.error],
  );
  return createElement(FlagsContext.Provider, { value: state }, props.children);
}

/** The values, loading and error of the nearest `FlagsProvider` (throws outside one). */
export function useFlags(): FlagsState {
  const s = useContext(FlagsContext);
  if (!s) throw new Error("useFlags/useFlag: wrap the tree in <FlagsProvider query={api.flags.forClient} args={...}>");
  return s;
}

/**
 * A flag's value, or `fallback` while loading, when the flag is missing or not client-visible, or when its value is
 * not of the fallback's type (`typeof`; a `null` fallback accepts anything).
 */
export function useFlag<V>(key: string, fallback: V): V {
  const { values } = useFlags();
  const value = values?.[key];
  if (value === undefined) return fallback;
  if (fallback !== null && fallback !== undefined && typeof value !== typeof fallback) return fallback;
  return value as V;
}
