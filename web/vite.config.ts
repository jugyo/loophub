import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// lh-web server. Always a separate process from this dev server.
const API_TARGET = process.env.VITE_LOOPHUB_API_URL ?? "http://localhost:8730";

// lh-web surface proxied to the server: JSON-RPC at /rpc, the SSE feed at /events,
// and the binary attachment upload/serve route at /attachments.
const API_PATHS = ["/rpc", "/events", "/attachments"];

// Shared proxy map used by both the dev server and `vite preview`. Vite's
// `preview` command ignores `server.proxy` and reads `preview.proxy`, so the
// production-like flow (`npm run build && npm run preview`) needs this
// referenced from both to avoid 404s on RPC/SSE calls.
const API_PROXY = Object.fromEntries(
  API_PATHS.map((p) => [
    p,
    {
      target: API_TARGET,
      changeOrigin: true,
      // EventSource keeps /events open; do not buffer.
      ws: false,
    },
  ]),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: API_PROXY,
  },
  preview: {
    proxy: API_PROXY,
  },
});
