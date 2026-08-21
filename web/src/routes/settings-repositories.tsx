import { createRoute } from "@tanstack/react-router";
import { RepositoriesPage } from "@/components/repositories-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const settingsRepositoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/repositories",
  component: function SettingsRepositoriesRoutePage() {
    usePageTitle(["Settings", "Repositories"]);
    return <RepositoriesPage />;
  },
});
