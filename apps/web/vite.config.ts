import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://127.0.0.1:4000";

// Single origin in development: the browser only talks to Vite, which proxies the API,
// media files and live HLS. Mirrors Caddy in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Main chunk ~190 KB gzipped (React, router, tRPC, Uppy, auth); the player is split out.
  build: { chunkSizeWarningLimit: 700 },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: api, xfwd: true },
      "/media": { target: api, xfwd: true },
      "/live": { target: api, xfwd: true },
    },
  },
});
