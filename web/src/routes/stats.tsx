import { createRoute } from "@tanstack/react-router";
import { AgentSessionsPage } from "@/components/agent-sessions-page";
import { DatabaseStatsPage } from "@/components/stats-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

// Stats is a two-tab screen (see stats-header.tsx): /stats is the Agent cost tab,
// /stats/db the DB Stats tab.
export const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: function StatsRoutePage() {
    usePageTitle(["Stats"]);
    return <AgentSessionsPage />;
  },
});

export const statsDbRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats/db",
  component: function StatsDbRoutePage() {
    usePageTitle(["DB Stats", "Stats"]);
    return <DatabaseStatsPage />;
  },
});
