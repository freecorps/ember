// Must FAIL to type-check: every line marked `// ERR` has to produce a diagnostic (test/typegen.test.ts).
import type { Client } from "cfx/client";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

export async function wrong(client: Client, me: Id<"users">, msg: Id<"messages">) {
  await client.query(api.messages.list, { channel: 42 }); // ERR wrong arg type
  await client.query(api.messages.list, {}); // ERR missing required arg
  await client.query(api.messages.lisst, { channel: "x" }); // ERR no such function
  await client.mutation(api.messages.list, { channel: "x" }); // ERR query used as mutation
  await client.query(internal.nested.admin.stats); // ERR internal function from client
  await client.mutation(api.messages.send, { channel: "x", author: msg, body: "b" }); // ERR Id<"messages"> is not Id<"users">
  const rows = await client.query(api.messages.list, { channel: "x" });
  const n: string = rows[0]!.likes; // ERR likes is number
  rows[0]!.nope; // ERR no such field
  await client.query(api.users.byEmail); // ERR args required
  return me;
}
