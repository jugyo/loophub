import { createRoute } from "@tanstack/react-router";
import { MergedList } from "@/components/pull-list";
import { usePageTitle } from "@/lib/page-title";
import { rootRoute } from "./root";

function MergedPage() {
  const { owner, repo } = mergedRoute.useParams();
  usePageTitle([`${owner}/${repo}`, "Merged pull requests"]);
  return <MergedList owner={owner} repo={repo} />;
}

export const mergedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/merged",
  component: MergedPage,
});
