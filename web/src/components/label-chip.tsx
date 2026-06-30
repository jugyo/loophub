// Clickable label chip: navigates to the issues list filtered by this label
// (`/r/:owner/:repo/issues?labels=<name>`). Shared by every place that renders a
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
  className,
}: {
  name: string;
  owner: string;
  repo: string;
  className?: string;
}) {
  return (
    <Link
      to="/r/$owner/$repo/issues"
      params={{ owner, repo }}
      search={{ labels: name }}
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
