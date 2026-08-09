// SPA build for lh-web. lh-web runs this once at startup and then serves the resulting web/dist
// as plain static files (http.ts's handleStatic): no Vite middleware, no dev client, no HMR
// WebSocket, so editing a source file cannot move the page someone is working in (#126). The
// cost is that a source change needs an lh-web restart to reach the browser.
// Kept out of http.ts so the HTTP core never imports Vite and its tests stay Vite-free.
// `vite` is imported dynamically: it is only needed when actually building.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// web/ project root — holds vite.config.ts and index.html.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Writes web/dist, replacing whatever an earlier run left there. Vite's own build log goes to
// this process's stdout, which is where the few seconds it takes are accounted for.
// `outDir` exists so a caller can build somewhere other than the directory a running lh-web is
// serving: replacing those files under a live process breaks the chunks its open tabs still
// lazy-import, which is the kind of accident this whole change is about avoiding.
export async function buildSpa(outDir?: string): Promise<void> {
  const { build } = await import("vite");
  await build({
    root: WEB_ROOT,
    ...(outDir ? { build: { outDir, emptyOutDir: true } } : {}),
  });
}
