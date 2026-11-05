import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `ember dev` serves the backend on :8787 (`EMBER_URL` to change it). The Worker sends no CORS headers for /api, so
// the page talks to it through this proxy and stays same-origin.
const backend = process.env.EMBER_URL ?? "http://localhost:8787";
export default defineConfig({
  plugins: [react()],
  // Inside the Ember monorepo the packages are used from source; with the published packages, drop this line.
  resolve: { conditions: ["@freecorps/ember-source"] },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
});
