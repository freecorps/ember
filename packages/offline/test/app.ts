// The test app with the engine on node:sqlite (see shared-app.ts).
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { engineServerWith, type Server } from "./shared-app.ts";

export * from "./shared-app.ts";

export const engineServer = (): Server => engineServerWith(createNodeSqliteDriver());
