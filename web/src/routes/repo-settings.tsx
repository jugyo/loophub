import { createRoute } from "@tanstack/react-router";
import { RepoSettingsPage } from "@/components/repo-settings-page";
import { rootRoute } from "./root";

function RepoSettingsRoutePage() {
  const { owner, repo } = repoSettingsRoute.useParams();
  return <RepoSettingsPage owner={owner} repo={repo} />;
}

export const repoSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings",
  component: RepoSettingsRoutePage,
});
