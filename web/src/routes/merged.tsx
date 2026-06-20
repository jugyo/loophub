import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { MergedList } from "@/components/pull-list";

function MergedPage() {
  const { owner, repo } = mergedRoute.useParams();
  return <MergedList owner={owner} repo={repo} />;
}

export const mergedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/merged",
  component: MergedPage,
});
