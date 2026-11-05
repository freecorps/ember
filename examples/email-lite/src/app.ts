// The app's modules as `createEmberWorker` takes them (the workerd test; `ember deploy` generates the same).
import schema from "../ember/schema.ts";
import app from "../ember/ember.config.ts";
import http from "../ember/http.ts";

export const functions = {};
export { schema, app, http };
