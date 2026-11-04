import { DurableObject } from "cloudflare:workers";
const CODE_TAG = "__TAG__";
export class Shard extends DurableObject {
  constructor(ctx, env) { super(ctx, env); ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits(v TEXT, at INTEGER)"); }
  async hit(workerVersion) {
    const v = this.env.VER?.id;
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (?,?)", v ?? "?", Date.now());
    const n = this.ctx.storage.sql.exec("SELECT count(*) c FROM hits").one().c;
    return { doVersion: v, doTag: CODE_TAG, workerVersion, n };
  }
}
export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const id = u.searchParams.get("id") ?? "a";
    const stub = env.SHARD.get(env.SHARD.idFromName(id));
    const r = await stub.hit(env.VER?.id);
    return Response.json({ ...r, workerTag: CODE_TAG, sqlite: true });
  },
};
