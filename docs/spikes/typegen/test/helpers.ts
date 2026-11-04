import { Engine, mutationGeneric, openSqlite, queryGeneric } from "cfx";
import schema from "../sample/schema";

export { schema };

/** Fresh shard with the sample schema, plus raw-write helpers (each call = one committed mutation). */
export function fresh() {
  const sql = openSqlite();
  const { engine } = Engine.push(sql, schema);
  const tx = <R>(fn: (db: any) => Promise<R>) =>
    engine.runMutation(mutationGeneric({ handler: (ctx: any) => fn(ctx.db) }) as any, {}) as Promise<{ value: R; changes: any[] }>;
  const insert = async (table: string, doc: Record<string, unknown>) => (await tx((db) => db.insert(table, doc))).value as string;
  const patch = (id: string, doc: Record<string, unknown>) => tx((db) => db.patch(id, doc));
  const del = (id: string) => tx((db) => db.delete(id));
  const run = (fn: (db: any) => Promise<unknown>) => engine.runQuery(queryGeneric({ handler: (ctx: any) => fn(ctx.db) }) as any, {}) as Promise<{ value: any; readSet: any[] }>;
  return { sql, engine, tx, insert, patch, del, run };
}

export async function withUser(env: ReturnType<typeof fresh>) {
  return env.insert("users", { name: "Ada", email: "ada@x.dev", admin: false });
}
