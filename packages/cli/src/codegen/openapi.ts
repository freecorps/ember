// `ember openapi` (docs/design/dx.md §3.11): an OpenAPI 3.1 document of the app, from the manifest. Public functions
// are `POST /api/<query|mutation|action>/<module:fn>` (the args are the body; `?shard=`), typed routes are their own
// paths. Schemas are the JSON Schema of the wire form (bigint and bytes as `{ $int64 }` / `{ $bytes }`).

import { toJsonSchema, type JsonSchema, type Shape } from "@freecorps/ember-values";
import type { EmberManifest } from "./index.ts";

const ERROR: JsonSchema = {
  type: "object",
  properties: { code: { type: "string" }, message: { type: "string" }, data: {}, kind: { const: "app" } },
  required: ["code", "message"],
};

export function openApi(manifest: EmberManifest, info: { title: string; version?: string; url?: string }): Record<string, unknown> {
  const schemas: Record<string, JsonSchema> = { EmberError: ERROR };
  for (const e of manifest.errors ?? []) {
    schemas[e.code] = {
      type: "object",
      description: e.message ?? e.code,
      properties: { code: { const: e.code }, message: { type: "string" }, kind: { const: "app" }, ...(e.data ? { data: toJsonSchema(e.data) } : {}) },
      required: ["code", "message", "kind", ...(e.data ? ["data"] : [])],
    };
  }
  const errorsOf = (codes: string[] | undefined): JsonSchema =>
    codes?.length ? { oneOf: [...codes.map((c) => ({ $ref: `#/components/schemas/${c}` })), { $ref: "#/components/schemas/EmberError" }] } : { $ref: "#/components/schemas/EmberError" };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const f of manifest.functions) {
    if (f.visibility !== "public" || f.type === "httpAction" || f.name.startsWith("@")) continue;
    paths[`/api/${f.type}/${f.name}`] = {
      post: {
        operationId: f.name.replace(/[/:]/g, "_"),
        summary: `${f.type} ${f.name}`,
        tags: [f.name.split(":")[0]!],
        parameters: [
          {
            name: "shard",
            in: "query",
            required: !!f.shard && f.shard.fromArg === undefined,
            description: f.shard ? (f.shard.fromArg ? `Default: ${f.shard.kind}:<${f.shard.fromArg}>` : `A ${f.shard.kind}:<key> shard`) : "Default: global:main",
            schema: { type: "string", ...(f.shard ? { pattern: `^${f.shard.kind}:` } : {}) },
          },
        ],
        requestBody: { required: true, content: { "application/json": { schema: f.args ? toJsonSchema(f.args) : { type: "object" } } } },
        responses: {
          "200": {
            description: "The result",
            content: { "application/json": { schema: { type: "object", properties: { ok: { const: true }, value: f.returns ? toJsonSchema(f.returns) : {} }, required: ["ok", "value"] } } },
          },
          "400": {
            description: "Refused (validation, application error)",
            content: { "application/json": { schema: { type: "object", properties: { ok: { const: false }, error: errorsOf(f.errors) }, required: ["ok", "error"] } } },
          },
          "401": { description: "Invalid token" },
        },
      },
    };
  }
  for (const r of manifest.routes ?? []) {
    const path = r.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    const param = (where: "path" | "query", name: string, shape: Shape, optional: boolean) => ({ name, in: where, required: where === "path" || !optional, schema: toJsonSchema(shape) });
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      operationId: `${r.method.toLowerCase()}${path.replace(/[^A-Za-z0-9]+/g, "_")}`,
      ...(r.description ? { summary: r.description } : {}),
      parameters: [
        ...Object.entries(r.params.fields).map(([k, f]) => param("path", k, f.shape, false)),
        ...Object.entries(r.query.fields).map(([k, f]) => param("query", k, f.shape, f.optional)),
      ],
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: toJsonSchema(r.body) } } } } : {}),
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: r.returns ? toJsonSchema(r.returns) : {} } } },
        default: { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: errorsOf(r.errors) }, required: ["error"] } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: info.title, version: info.version ?? manifest.schema.version.slice(0, 12) },
    ...(info.url ? { servers: [{ url: info.url }] } : {}),
    paths,
    components: { schemas, securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    security: [{}, { bearer: [] }],
  };
}
