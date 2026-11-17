# @freecorps/ember-values

The value layer of [Ember](https://github.com/freecorps/ember): the `v.*` validators, their `Shape` (the plain-data
form stored in the schema manifest), JSON Schema, the tagged JSON encoding used on the wire and the order-preserving
index key encoding. Pure TypeScript with no Cloudflare or Node APIs: it runs in workerd, browsers and React Native.

```sh
npm install @freecorps/ember-values
```

Apps rarely import it directly: `@freecorps/ember-server` re-exports `v`, `Infer`, `GenericId`, `FileId`,
`paginationOptsValidator`, `paginationResultValidator` and `unsafeRef`.

```ts
import { v, type Infer, toJsonSchema, encodeJson, decodeJson } from "@freecorps/ember-values";

const message = v.object({
  author: v.string().min(1).max(80),
  body: v.string().nonempty().describe("Markdown"),
  likes: v.number().int().nonnegative(),
  roomId: v.id("rooms"),
  attachment: v.optional(v.file()),
  seq: v.int64(),
});
type Message = Infer<typeof message>;

message.validate({ author: "", body: "hi", likes: 0, roomId: "r1", seq: 1n }); // { ok: false, path, message }
toJsonSchema(message.shape);                    // JSON Schema (what `ember openapi` builds on)
decodeJson(encodeJson({ seq: 1n }));            // bigint and bytes survive: {"seq":{"$int64":"1"}}
```

## What is in it

- **Validators** (`v`): `string`, `number` / `float64`, `int64` (a `bigint`), `boolean`, `null`, `bytes`, `file`,
  `id(table)`, `literal`, `array`, `record`, `object`, `union`, `optional`, `nullable`, `any` (typed `unknown`) and
  `unsafeAny` (typed `any`). Refinements: strings `min`, `max`, `nonempty`, `email`, `url`, `uuid`, `regex`; numbers
  `int`, `min`, `max`, `positive`, `nonnegative`; arrays `min`, `max`, `nonempty`; objects `pick`, `omit`, `partial`,
  `extend`. Every validator has `describe(text)`, `validate(value)` and, for function arguments, `default(value)`.
  Validators implement Standard Schema v1.
- **Types**: `Infer<V>`, `InferInput<V>`, `GenericId<"table">`, `FileId`, `FunctionReference` and friends.
- **Pagination**: `paginationOptsValidator` (`{ numItems, cursor, endCursor? }`) and `paginationResultValidator(item)`.
- **Shapes and validation**: `Shape`, `validate(shape, value)`, `validatorFromShape`, `withDefaults`, `shapeAtPath`.
- **JSON**: `encodeJson` / `decodeJson` (canonical JSON with `$int64`, `$bytes` and `$float` tags), `encodeJsonStable`
  (sorted keys, for cache keys), `toJSONValue` / `fromJSONValue`, `toJsonSchema(shape)`.
- **Index keys**: `encodeKey(values)` / `decodeKey`, FoundationDB-tuple style, compared as bytes; `rangeFor(eq, lower?,
  upper?)`, `prefixEnd`, `keySuccessor`, `compareValues`.

## Limits

- Field names starting with `$` are rejected, so they never collide with the JSON tags.
- Type order in keys: `undefined < null < int64 < number < boolean < string < bytes < array < object`; numbers in IEEE
  total order (`-0 < +0`, NaN after `+Infinity`), strings by code point.
- `.default()` is for function arguments only; table schemas do not accept it.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md),
"Valores e JSON" (in Portuguese). Validator API and typing rules: [`docs/design/dx.md`](https://github.com/freecorps/ember/blob/main/docs/design/dx.md).

License: MIT.
