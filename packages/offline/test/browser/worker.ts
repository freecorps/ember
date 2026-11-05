// The app's offline Worker, as an app would write it (bundled by the test with esbuild): OPFS storage served to the
// page. It loads SQLite-Wasm through the adapter's default (static) import. Role changes go to the page for checks.
import { serveOpfsStorage } from "../../src/opfs-worker.ts";
import { offlineQueries, schema } from "../shared-app.ts";

const name = new URL(self.location.href).searchParams.get("name") ?? "e2e";
serveOpfsStorage({
  name,
  schema,
  queries: offlineQueries,
  onRoleChange: (role) => (self as unknown as { postMessage(m: unknown): void }).postMessage({ role }),
});
