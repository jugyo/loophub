// Resolver route for in-body `#n` references (/r/:owner/:repo/n/:number). A `#n`
// is unambiguous within a repo (issues and PRs share one number space), but its
// kind is only known after a lookup, so this route fetches the entity and
// redirects to the issues or pulls detail route accordingly. Mirrors GitHub,
// where /issues/<n> redirects to the PR when <n> is a pull request.

import { createRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useIssue } from "@/queries/issues";
import { rootRoute } from "./root";

function RefRedirect() {
  const { owner, repo, number } = refRoute.useParams();
  const navigate = useNavigate();
  const { data, isError, error } = useIssue(owner, repo, Number(number));

  useEffect(() => {
    if (!data) return;
    if (data.pull_request) {
      navigate({
        to: "/r/$owner/$repo/pulls/$number",
        params: { owner, repo, number },
        replace: true,
      });
    } else {
      navigate({
        to: "/r/$owner/$repo/issues/$number",
        params: { owner, repo, number },
        replace: true,
      });
    }
  }, [data, navigate, owner, repo, number]);

  if (isError) {
    return (
      <div
        data-debug-component="RefRedirect"
        className="mx-auto max-w-content rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
      >
        #{number} not found.
        {error instanceof Error ? ` ${error.message}` : null}
      </div>
    );
  }
  return (
    <div
      data-debug-component="RefRedirect"
      className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" /> Resolving #{number}…
    </div>
  );
}

export const refRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/n/$number",
  component: RefRedirect,
});
