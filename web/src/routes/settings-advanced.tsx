import { createRoute } from "@tanstack/react-router";
import { AdvancedSettingsPage } from "@/components/advanced-settings-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const settingsAdvancedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/advanced",
  component: function SettingsAdvancedRoutePage() {
    usePageTitle(["Settings", "Advanced"]);
    return <AdvancedSettingsPage />;
  },
});
