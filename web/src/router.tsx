import { createRouter } from "@tanstack/react-router";
import { agentsRoute } from "./routes/agents";
import { indexRoute } from "./routes/index";
import { issueDetailRoute } from "./routes/issues";
import { pullDetailRoute } from "./routes/pulls";
import { repoRoute } from "./routes/repo";
import {
  repoSettingsArchiveRoute,
  repoSettingsCodingAgentRoute,
  repoSettingsPullRequestsRoute,
  repoSettingsRoute,
  repoSettingsWorkflowsRoute,
  repoSettingsWorkspacesRoute,
} from "./routes/repo-settings";
import { rootRoute } from "./routes/root";
import { sessionsRoute } from "./routes/sessions";
import { settingsRoute } from "./routes/settings";
import { settingsNotificationsRoute } from "./routes/settings-notifications";
import { settingsRepositoriesRoute } from "./routes/settings-repositories";
import { settingsWorkflowsRoute } from "./routes/settings-workflows";
import { statsDbRoute, statsRoute } from "./routes/stats";
import { uiCatalogRoute } from "./routes/ui-catalog";

// App-shell route tree. Leaf components are placeholders; later UI issues
// replace each screen in place without changing this tree.
const routeTree = rootRoute.addChildren([
  indexRoute,
  agentsRoute,
  repoRoute,
  repoSettingsRoute,
  repoSettingsPullRequestsRoute,
  repoSettingsCodingAgentRoute,
  repoSettingsWorkspacesRoute,
  repoSettingsWorkflowsRoute,
  repoSettingsArchiveRoute,
  issueDetailRoute,
  pullDetailRoute,
  settingsRoute,
  settingsWorkflowsRoute,
  settingsRepositoriesRoute,
  settingsNotificationsRoute,
  sessionsRoute,
  statsRoute,
  statsDbRoute,
  uiCatalogRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
