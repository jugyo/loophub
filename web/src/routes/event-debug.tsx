import { createRoute } from "@tanstack/react-router";
import { EventDebugPage } from "@/components/event-debug-page";
import { rootRoute } from "./root";

export const eventDebugRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/debug/events",
  component: EventDebugPage,
});
