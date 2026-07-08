import { createRoute } from "@tanstack/react-router";
import { InboxPage } from "@/components/inbox-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: function InboxRoutePage() {
    usePageTitle(["Inbox"]);
    return <InboxPage />;
  },
});
