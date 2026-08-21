import { createRoute } from "@tanstack/react-router";
import { NotificationSettingsPage } from "@/components/notification-settings-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const settingsNotificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/notifications",
  component: function SettingsNotificationsRoutePage() {
    usePageTitle(["Settings", "Notifications"]);
    return <NotificationSettingsPage />;
  },
});
