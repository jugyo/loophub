import { createRoute, Navigate } from "@tanstack/react-router";
import { InboxPage } from "@/components/inbox-page";
import { usePageTitle } from "@/lib/page-title";
import { useWebConfig } from "@/lib/web-config";
import { rootRoute } from "./root";

function InboxRoutePage() {
  const { experimental } = useWebConfig();
  usePageTitle(["Inbox"]);
  if (!experimental) {
    return <Navigate to="/" />;
  }
  return <InboxPage />;
}

export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxRoutePage,
});
