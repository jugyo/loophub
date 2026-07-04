import { createRoute } from "@tanstack/react-router";
import { EventDebugPage } from "@/components/event-debug-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const eventDebugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug/events",
  component: function EventDebugRoutePage() {
    usePageTitle(["Event debug"]);
    return <EventDebugPage />;
  },
});
