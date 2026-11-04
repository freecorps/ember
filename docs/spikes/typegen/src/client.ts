// Client surface typed by function references. The transport here is in-process (engine + subscription
// manager); the real one speaks WebSocket to the shard, with the same signatures.

import type { Engine } from "./engine";
import { SubscriptionManager } from "./reactivity";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType, type OptionalRestArgs, type RegisteredFunction } from "./server";

export type Modules = Record<string, Record<string, unknown>>;

export interface Client {
  query<F extends FunctionReference<"query", "public">>(f: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  mutation<F extends FunctionReference<"mutation", "public">>(f: F, ...args: OptionalRestArgs<F>): Promise<FunctionReturnType<F>>;
  subscribe<F extends FunctionReference<"query", "public">>(
    f: F,
    args: FunctionArgs<F>,
    onUpdate: (value: FunctionReturnType<F>) => void,
  ): Promise<() => void>;
}

/** Resolves "dir/module:export" in a modules map (what codegen's _generated/modules.js exports). */
export function resolve(modules: Modules, name: string): RegisteredFunction<any, any, any, any> {
  const [path, exp = "default"] = name.split(":");
  const fn = modules[path!]?.[exp] as RegisteredFunction<any, any, any, any> | undefined;
  if (!fn?.isRegistered) throw new Error(`Unknown function ${name}`);
  return fn;
}

export function createLocalClient(engine: Engine, modules: Modules): Client & { subs: SubscriptionManager } {
  const subs = new SubscriptionManager(engine);
  const listeners = new Map<string, (v: any) => void>();
  let n = 0;
  const pub = (ref: unknown, type: string) => {
    const fn = resolve(modules, getFunctionName(ref as any));
    if (fn.type !== type || fn.visibility !== "public") throw new Error(`${getFunctionName(ref as any)} is not a public ${type}`);
    return fn;
  };
  return {
    subs,
    async query(f, ...args) {
      return (await engine.runQuery(pub(f, "query") as any, args[0] ?? {})).value as any;
    },
    async mutation(f, ...args) {
      const { value, changes } = await engine.runMutation(pub(f, "mutation") as any, args[0] ?? {});
      for (const p of await subs.onCommit(changes)) listeners.get(p.subId)?.(p.value);
      return value as any;
    },
    async subscribe(f, args, onUpdate) {
      const id = `s${++n}`;
      listeners.set(id, onUpdate);
      onUpdate((await subs.subscribe(id, pub(f, "query") as any, args)) as any);
      return () => {
        listeners.delete(id);
        subs.unsubscribe(id);
      };
    },
  };
}
