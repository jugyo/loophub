import { createRouter } from "@tanstack/react-router";
import { archivedRoute } from "./routes/archived";
import { inboxRoute } from "./routes/inbox";
import { indexRoute } from "./routes/index";
import { issueDetailRoute } from "./routes/issues";
import { pullDetailRoute } from "./routes/pulls";
import { refRoute } from "./routes/ref";
import { repoRoute } from "./routes/repo";
import { repoIssuesRoute } from "./routes/repo-issues";
import { repoScheduledTasksRoute } from "./routes/repo-scheduled-tasks";
import { repoSettingsRoute } from "./routes/repo-settings";
import { rootRoute } from "./routes/root";
import { sessionsRoute } from "./routes/sessions";
import { settingsRoute } from "./routes/settings";
import { settingsWorkflowsRoute } from "./routes/settings-workflows";
import { statsDbRoute, statsRoute, statsSessionsRoute } from "./routes/stats";
import { uiCatalogRoute } from "./routes/ui-catalog";

// App-shell route tree. Leaf components are placeholders; later UI issues
// replace each screen in place without changing this tree.
const routeTree = rootRoute.addChildren([
  indexRoute,
  archivedRoute,
  inboxRoute,
  repoRoute,
  repoIssuesRoute,
  repoScheduledTasksRoute,
  repoSettingsRoute,
  issueDetailRoute,
  pullDetailRoute,
  refRoute,
  settingsRoute,
  settingsWorkflowsRoute,
  sessionsRoute,
  statsRoute,
  statsDbRoute,
  statsSessionsRoute,
  uiCatalogRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
