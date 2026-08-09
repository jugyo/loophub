import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Used by `vite build` — both from the command line and from the build lh-web runs at
// startup (web/server/build.ts). There is intentionally no standalone dev server or API
// proxy here: the SPA is always served same-origin, same process, by its own lh-web
// (issue #1669), as static files it built.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
