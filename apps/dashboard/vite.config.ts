// Local UI development only: `bun run dev` serves the SPA and proxies /api to a running dashboard Worker
// (EMBER_DASHBOARD_URL, e.g. https://ember-dashboard.<sub>.workers.dev). Deploys bundle with esbuild (`ember dashboard deploy`).
import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  server: { proxy: { "/api": { target: process.env.EMBER_DASHBOARD_URL ?? "http://localhost:8788", changeOrigin: true } } },
});
