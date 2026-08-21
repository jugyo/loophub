import { createRoute } from "@tanstack/react-router";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export function HomePage() {
  usePageTitle(["Home"]);

  return (
    <div
      data-debug-component="HomePage"
      className="mx-auto flex max-w-content flex-col gap-8"
    >
      <div>
        <h1 className="text-2xl font-semibold">Home</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick a repository from the topbar to browse its issues and pull
          requests.
        </p>
      </div>
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
