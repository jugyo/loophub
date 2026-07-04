import { createRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: function SettingsRoutePage() {
    usePageTitle(["Settings"]);
    return <SettingsPage />;
  },
});
