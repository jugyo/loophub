import { createRouter } from "@tanstack/react-router";
import { rootRoute } from "./routes/root";
import { indexRoute } from "./routes/index";
import { archivedRoute } from "./routes/archived";
import { repoRoute } from "./routes/repo";
import { issuesRoute, issueDetailRoute } from "./routes/issues";
import { pullsRoute, pullDetailRoute } from "./routes/pulls";
import { mergedRoute } from "./routes/merged";

// App-shell route tree. Leaf components are placeholders; later UI issues
// replace each screen in place without changing this tree.
const routeTree = rootRoute.addChildren([
  indexRoute,
  archivedRoute,
  repoRoute,
  issuesRoute,
  issueDetailRoute,
  pullsRoute,
  pullDetailRoute,
  mergedRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
