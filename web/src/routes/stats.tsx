import { createRoute } from "@tanstack/react-router";
import { AgentSessionsPage } from "@/components/agent-sessions-page";
import { DatabaseStatsPage, StatsPage } from "@/components/stats-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: function StatsRoutePage() {
    usePageTitle(["Stats"]);
    return <StatsPage />;
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

export const statsSessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats/sessions",
  component: function StatsSessionsRoutePage() {
    usePageTitle(["Agent sessions", "Stats"]);
    return <AgentSessionsPage />;
  },
});
