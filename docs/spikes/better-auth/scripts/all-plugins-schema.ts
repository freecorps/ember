/** Codegen check across the plugin list we want first-party support for. */
import { getAuthTables } from "better-auth/db";
import { organization, admin, twoFactor, magicLink, emailOTP, jwt, bearer, anonymous, username, phoneNumber } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { apiKey } from "@better-auth/api-key";
import { schemaDDL } from "../src/ddl.ts";
const noop = async () => {};
const options = {
  emailAndPassword: { enabled: true },
  plugins: [
    organization({ teams: { enabled: true } }), admin(), twoFactor(), passkey(), magicLink({ sendMagicLink: noop }),
    emailOTP({ sendVerificationOTP: noop }), apiKey(), jwt(), bearer(), anonymous(), username(), phoneNumber(),
  ],
} as any;
const t = getAuthTables(options);
for (const [k, v] of Object.entries(t)) {
  const extra = Object.entries(v.fields).map(([f, a]: any) => `${f}:${Array.isArray(a.type) ? "enum" : a.type}${a.required === false ? "?" : ""}${a.references ? "->" + a.references.model : ""}`);
  console.log(`${k} (${v.modelName}): ${extra.join(", ")}`);
}
const ddl = schemaDDL(options);
console.log(`\n${ddl.length} DDL statements`);
// Prove the DDL is valid SQLite (node:sqlite, same engine family as DO SQLite)
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(":memory:");
for (const s of ddl) db.exec(s);
console.log("applied OK to sqlite:", db.prepare("select count(*) n from sqlite_master where type='table'").get());
