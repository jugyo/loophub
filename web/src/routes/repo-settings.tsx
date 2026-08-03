import { createRoute, useParams } from "@tanstack/react-router";
import {
  RepoSettingsPage,
  type RepoSettingsSection,
} from "@/components/repo-settings-page";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function RepoSettingsRoutePage({ section }: { section: RepoSettingsSection }) {
  const { owner, repo } = useParams({ strict: false }) as {
    owner: string;
    repo: string;
  };
  usePageTitle([`${owner}/${repo}`, "Settings"]);
  return <RepoSettingsPage owner={owner} repo={repo} section={section} />;
}

export const repoSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings",
  component: () => <RepoSettingsRoutePage section="general" />,
});

export const repoSettingsPullRequestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings/pull-requests",
  component: () => <RepoSettingsRoutePage section="pull-requests" />,
});

export const repoSettingsCodingAgentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings/coding-agent",
  component: () => <RepoSettingsRoutePage section="coding-agent" />,
});

export const repoSettingsWorkspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings/workspaces",
  component: () => <RepoSettingsRoutePage section="workspaces" />,
});

export const repoSettingsWorkflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings/workflows",
  component: () => <RepoSettingsRoutePage section="workflows" />,
});

export const repoSettingsArchiveRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/settings/archive",
  component: () => <RepoSettingsRoutePage section="archive" />,
});
