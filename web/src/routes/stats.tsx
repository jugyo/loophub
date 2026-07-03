import { createRoute } from "@tanstack/react-router";
import { StatsPage } from "@/components/stats-page";
import { rootRoute } from "./root";

export const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: StatsPage,
});
