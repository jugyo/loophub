// Clickable label chip: navigates to the repo issue list filtered by this label
// (`/r/:owner/:repo?labels=<name>`). Shared by every place that renders a
// label (issue detail, list rows) so the chip stays visually identical and the
// "click a label to filter" behaviour lives in one spot (#368). Colour and
// shape come from the same helpers as the old static chips
// (LABEL_CHIP_BASE_CLASS + labelColorClass), so the only visible change is the
// pointer cursor / hover feedback. stopPropagation guards the case where a chip
// sits inside a clickable row, so the label filter wins over the row link.

import { Link } from "@tanstack/react-router";
import { LABEL_CHIP_BASE_CLASS, labelColorClass } from "@/lib/label-color";
import { cn } from "@/lib/utils";

export function LabelChip({
  name,
  owner,
  repo,
  state,
  workspace,
  workspaceFilter,
  className,
}: {
  name: string;
  owner: string;
  repo: string;
  state?: "open" | "closed" | "all";
  workspace?: string;
  /** Repo-top workspace filter to carry into the `/r/:owner/:repo` label link (#1494). */
  workspaceFilter?: string;
  className?: string;
}) {
  const search = {
    labels: name,
    state: state === "open" ? undefined : state,
    workspace: workspaceFilter,
  };
  const linkProps = workspace
    ? {
        to: "/r/w/$workspaceName" as const,
        params: { workspaceName: workspace },
        search,
      }
    : {
        to: "/r/$owner/$repo" as const,
        params: { owner, repo },
        search,
      };
  return (
    <Link
      {...linkProps}
      title={`Filter issues by "${name}"`}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        LABEL_CHIP_BASE_CLASS,
        labelColorClass(name),
        "cursor-pointer hover:opacity-80",
        className,
      )}
    >
      {name}
    </Link>
  );
}
