import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getSettings, getWebConfig } from "@/api/client";
import { errorMessage } from "@/lib/error-message";
import { applyTheme, resolveInitialTheme } from "@/lib/theme";
import { WebConfigProvider } from "@/lib/web-config";
import { router } from "@/router";

interface BootstrapDependencies {
  getSettings: typeof getSettings;
  getWebConfig: typeof getWebConfig;
}

const defaultDependencies: BootstrapDependencies = {
  getSettings,
  getWebConfig,
};

function StartupError({ error }: { error: unknown }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section
        role="alert"
        className="w-full max-w-lg rounded-md border border-destructive/50 bg-background p-6 shadow-lg"
      >
        <h1 className="text-lg font-semibold">Unable to start LoopHub</h1>
        <p className="mt-2 text-sm text-destructive">
          {errorMessage(error, "Failed to load settings")}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Reload the page after the server is available.
        </p>
      </section>
    </main>
  );
}

export async function bootstrap(
  rootElement: HTMLElement,
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<Root> {
  const [webConfig, settingsResult] = await Promise.all([
    dependencies.getWebConfig().catch(() => ({
      debug: false,
    })),
    dependencies.getSettings().then(
      (settings) => ({ ok: true as const, settings }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  const root = createRoot(rootElement);

  if (!settingsResult.ok) {
    root.render(
      <StrictMode>
        <StartupError error={settingsResult.error} />
      </StrictMode>,
    );
    return root;
  }

  const queryClient = new QueryClient();
  queryClient.setQueryData(["settings"], settingsResult.settings);
  applyTheme(resolveInitialTheme(settingsResult.settings.theme));

  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <WebConfigProvider config={webConfig}>
          <RouterProvider router={router} />
        </WebConfigProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return root;
}
