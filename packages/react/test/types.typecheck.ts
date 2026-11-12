// Type-level tests of the hooks (checked by `tsc -b`, never run): docs/design/dx.md §3.3, §3.9.
import type { FunctionReference } from "@freecorps/ember-client";
import { isError } from "@freecorps/ember-client";
import { useAction, useMutation, useMutationState, usePaginatedQuery, useQuery, useQueryState, useSuspenseQuery, type PaginationResult } from "../src/index.ts";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};

type TooLong = { readonly code: "TooLong"; readonly data: { max: number } };
declare const api: {
  get: FunctionReference<"query", "public", { id: string }, { name: string } | null, never>;
  all: FunctionReference<"query", "public", {}, string[], never>;
  page: FunctionReference<"query", "public", { room: string; paginationOpts: { numItems: number; cursor: string | null } }, PaginationResult<{ body: string }>, never>;
  send: FunctionReference<"mutation", "public", { body: string }, string, TooLong>;
  ping: FunctionReference<"action", "public", {}, number, never>;
  stats: FunctionReference<"query", "public", {}, number, never, { kind: "org" }>;
};

export function Hooks() {
  const a = useQuery(api.get, { id: "x" });
  assert<Equals<typeof a, { name: string } | null | undefined>>();
  useQuery(api.all);
  useQuery(api.get, "skip");
  // @ts-expect-error required args
  useQuery(api.get);
  // @ts-expect-error wrong arg type
  useQuery(api.get, { id: 1 });
  // @ts-expect-error a string is not a reference
  useQuery("x:get", { id: "x" });

  const s = useQueryState(api.get, { id: "x" });
  if (s.status === "success") assert<Equals<typeof s.data, { name: string } | null>>();
  if (s.status === "error") assert<Equals<typeof s.error.code, string>>();

  // @ts-expect-error the org shard must be named
  useSuspenseQuery(api.stats);
  useSuspenseQuery(api.stats, {}, { shard: "org:acme" });
  // @ts-expect-error the org shard must be named
  useQuery(api.stats);
  // @ts-expect-error the org shard must be named
  useMutation(api.stats as unknown as FunctionReference<"mutation", "public", {}, number, never, { kind: "org" }>);
  const v = useSuspenseQuery(api.get, { id: "x" });
  assert<Equals<typeof v, { name: string } | null>>();

  const send = useMutation(api.send);
  void send({ body: "x" });
  // @ts-expect-error required args
  void send();
  void send.safe({ body: "x" }).then((r) => {
    if (r.ok) assert<Equals<typeof r.value, string>>();
    else if (r.error.kind === "app") assert<Equals<typeof r.error.data, { max: number }>>();
  });
  void send({ body: "x" }).catch((e: unknown) => {
    if (isError(e, api.send, "TooLong")) assert<Equals<typeof e.data, { max: number }>>();
    // @ts-expect-error not an error of api.send
    isError(e, api.send, "Nope");
  });

  const st = useMutationState(api.send);
  const err = st.error;
  if (err?.kind === "app") assert<Equals<typeof err.code, "TooLong">>();

  const ping = useAction(api.ping);
  void ping();

  const p = usePaginatedQuery(api.page, { room: "r" }, { initialNumItems: 10 });
  assert<Equals<typeof p.results, Array<{ body: string }>>>();
  // @ts-expect-error not a paginated query
  usePaginatedQuery(api.get, { id: "x" }, { initialNumItems: 10 });
  return null;
}
