// Must type-check cleanly (`tsc --noEmit -p .`). Compile-time assertions prove the types are precise, not `any`.
import type { Client } from "cfx/client";
import type { FunctionArgs, FunctionReturnType, OptionalRestArgs } from "cfx/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};

// Args and return types flow from the handler / validators to the client.
assert<Equals<FunctionArgs<typeof api.messages.list>, { channel: string; limit?: number }>>();
assert<Equals<FunctionReturnType<typeof api.messages.list>, Doc<"messages">[]>>();
assert<Equals<FunctionArgs<typeof api.messages.send>, { channel: string; author: Id<"users">; body: string }>>();
assert<Equals<FunctionReturnType<typeof api.messages.send>, Id<"messages">>>();
assert<Equals<FunctionReturnType<typeof api.users.byEmail>, Doc<"users"> | null>>();
assert<Equals<FunctionReturnType<typeof api.users.count>, number>>();
assert<Equals<OptionalRestArgs<typeof api.users.count>, [args?: {}]>>();
assert<
  Equals<
    FunctionReturnType<typeof api.messages.popular>,
    { page: { id: Id<"messages">; body: string; likes: number }[]; isDone: boolean; continueCursor: string }
  >
>();
assert<Equals<FunctionReturnType<typeof internal.nested.admin.stats>, { users: number; messages: number }>>();

// The document type: system fields + schema fields, optional stays optional, nested objects typed.
assert<
  Equals<
    Doc<"messages">,
    {
      _id: Id<"messages">;
      _creationTime: number;
      channel: string;
      author: Id<"users">;
      body: string;
      likes: number;
      meta?: { edited: boolean; tags: string[] };
      embedding?: number[];
    }
  >
>();

// Visibility: internal functions are not on `api`, public ones are not on `internal`, non-functions on neither.
type ApiMessages = keyof typeof api.messages;
assert<Equals<ApiMessages, "list" | "popular" | "search" | "similar" | "send" | "like">>();
assert<Equals<keyof typeof internal.messages, "purgeChannel">>();
assert<Equals<keyof typeof api, "messages" | "users">>(); // nested/admin has no public functions

export async function demo(client: Client, me: Id<"users">) {
  const msgs = await client.query(api.messages.list, { channel: "general" });
  const first: string | undefined = msgs[0]?.body.toUpperCase();
  const id = await client.mutation(api.messages.send, { channel: "general", author: me, body: "hi" });
  await client.mutation(api.messages.like, { id });
  const n: number = await client.query(api.users.count);
  const stop = await client.subscribe(api.messages.search, { channel: "general", text: "hello" }, (rows) => {
    rows.map((r) => r.likes.toFixed());
  });
  stop();
  return { first, n };
}
