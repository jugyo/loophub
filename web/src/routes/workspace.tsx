import { createRoute } from "@tanstack/react-router";
import { WorkspacePage } from "@/components/workspace-page";
import { validateIssueListSearch } from "./repo";
import { rootRoute } from "./root";

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/w/$workspaceName",
  component: function WorkspaceRoutePage() {
    const { workspaceName } = workspaceRoute.useParams();
    const { labels, state } = workspaceRoute.useSearch();
    return (
      <WorkspacePage
        workspaceName={workspaceName}
        labels={labels}
        state={state}
      />
    );
  },
  validateSearch: validateIssueListSearch,
});
