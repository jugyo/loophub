// Link to the repo's Scheduled tasks screen (/r/:owner/:repo/scheduled-tasks, #880), shown in the
// repo dashboard header next to Settings. A single entry point — the list/create/edit/delete all
// live on that screen (navigation-wide redesign is out of scope for #880).

import { Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useWebConfig } from "@/lib/web-config";

export function ScheduledTasksLink({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const { experimental } = useWebConfig();
  if (!experimental) return null;
  return (
    <Link
      to="/r/$owner/$repo/scheduled-tasks"
      params={{ owner, repo }}
      className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <Clock className="size-4" />
      Scheduled tasks
    </Link>
  );
}
