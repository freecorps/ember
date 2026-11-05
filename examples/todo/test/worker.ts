// Test-only Worker: the todo app on workerd (Miniflare). `ember dev` / `ember deploy` generate the same entry
// from the files in ember/.
import { createEmberWorker } from "@freecorps/ember-runtime";
import schema from "../ember/schema.ts";
import * as lists from "../ember/lists.ts";
import * as todos from "../ember/todos.ts";

export { Shard, System } from "@freecorps/ember-runtime";

export default createEmberWorker({ schema, functions: { lists, todos } });
