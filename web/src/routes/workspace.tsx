import { createRoute } from "@tanstack/react-router";
import { WorkspacePage } from "@/components/workspace-page";
import { rootRoute } from "./root";

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/w/$workspaceName",
  component: function WorkspaceRoutePage() {
    const { workspaceName } = workspaceRoute.useParams();
    return <WorkspacePage workspaceName={workspaceName} />;
  },
});
