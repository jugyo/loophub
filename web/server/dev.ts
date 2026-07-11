// Vite dev middleware for lh-web. Boots Vite in middleware mode so the single lh-web
// process serves the SPA (with HMR) alongside /rpc — no separate dev server,
// no second port. Kept out of http.ts so the HTTP core never imports Vite and its tests
// stay Vite-free. `vite` is imported dynamically: it is only needed when actually serving.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StaticHandler } from "./http.ts";

// web/ project root — holds vite.config.ts and index.html.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface ViteDev {
  // Delegates non-API GETs to Vite (transformed modules, assets, HMR client, and the
  // index.html SPA fallback). Drop-in for http.ts's StaticHandler.
  serveStatic: StaticHandler;
  close: () => Promise<void>;
}

// Start Vite in middleware mode, sharing `server` for HMR so the whole UI — assets and the
// live-reload WebSocket — lives on lh-web's single port.
export async function createViteDev(server: Server): Promise<ViteDev> {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: WEB_ROOT,
    // appType "spa" makes vite.middlewares serve index.html with a client-route fallback.
    appType: "spa",
    server: { middlewareMode: true, hmr: { server } },
  });
  const serveStatic: StaticHandler = (req, res) => {
    vite.middlewares(req as IncomingMessage, res as ServerResponse);
  };
  return { serveStatic, close: () => vite.close() };
}
