import { createRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings-page";
import { rootRoute } from "./root";

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
