import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Used by `vite build` (the fallback `dist/` bundle) and by the Vite middleware
// that lh-web embeds (web/server/dev.ts). There is intentionally no standalone
// dev server or API proxy here: the SPA is always served same-origin, same
// process, by its own lh-web (issue #1669). Run `npm run lh-web` for dev/HMR.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
