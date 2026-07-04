import { createRouter } from "@tanstack/react-router";
import { archivedRoute } from "./routes/archived";
import { eventDebugRoute } from "./routes/event-debug";
import { indexRoute } from "./routes/index";
import { issueDetailRoute, issuesRoute } from "./routes/issues";
import { mergedRoute } from "./routes/merged";
import { pullDetailRoute, pullsRoute } from "./routes/pulls";
import { refRoute } from "./routes/ref";
import { repoRoute } from "./routes/repo";
import { repoSettingsRoute } from "./routes/repo-settings";
import { rootRoute } from "./routes/root";
import { settingsRoute } from "./routes/settings";
import { statsRoute } from "./routes/stats";

// App-shell route tree. Leaf components are placeholders; later UI issues
// replace each screen in place without changing this tree.
const routeTree = rootRoute.addChildren([
  indexRoute,
  archivedRoute,
  eventDebugRoute,
  repoRoute,
  repoSettingsRoute,
  issuesRoute,
  issueDetailRoute,
  pullsRoute,
  pullDetailRoute,
  refRoute,
  mergedRoute,
  settingsRoute,
  statsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
