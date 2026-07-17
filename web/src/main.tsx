import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getWebConfig } from "./api/client";
import { applyTheme, resolveInitialTheme } from "./lib/theme";
import { WebConfigProvider } from "./lib/web-config";
import { router } from "./router";
import "./index.css";

const queryClient = new QueryClient();
applyTheme(resolveInitialTheme());

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
const webConfig = await getWebConfig().catch(() => ({
  experimental: false,
}));

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WebConfigProvider config={webConfig}>
        <RouterProvider router={router} />
      </WebConfigProvider>
    </QueryClientProvider>
  </StrictMode>,
);
