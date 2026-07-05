import { createRoute } from "@tanstack/react-router";
import { AgentSessionsPage } from "@/components/agent-sessions-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: function SessionsRoutePage() {
    usePageTitle(["Agent sessions"]);
    return <AgentSessionsPage />;
  },
});
