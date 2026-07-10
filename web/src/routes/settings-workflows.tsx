import { createRoute } from "@tanstack/react-router";
import { WorkflowsPage } from "@/components/workflows-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

export const settingsWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/workflows",
  component: function SettingsWorkflowsRoutePage() {
    usePageTitle(["Settings", "Workflows"]);
    return <WorkflowsPage />;
  },
});
