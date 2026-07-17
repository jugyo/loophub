import { createRoute } from "@tanstack/react-router";
import { AgentsPage } from "@/components/agents-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: function AgentsRoutePage() {
    usePageTitle(["Agents"]);
    return <AgentsPage />;
  },
});
