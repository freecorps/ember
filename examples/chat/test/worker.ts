// Test-only Worker: the chat app on workerd (Miniflare). `ember dev` / `ember deploy` generate the same entry
// from the files in ember/.
import { createEmberWorker } from "@freecorps/ember-runtime";
import schema from "../ember/schema.ts";
import * as messages from "../ember/messages.ts";
import * as rooms from "../ember/rooms.ts";

export { Shard, System } from "@freecorps/ember-runtime";

export default createEmberWorker({ schema, functions: { messages, rooms } });
