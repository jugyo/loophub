import { Link, useRouterState } from "@tanstack/react-router";
import { CalendarClock, CircleDot, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type RepoSection = "issues" | "scheduled-tasks" | "settings";

interface RepoRouteState {
  owner: string;
  repo: string;
  section: RepoSection | null;
}

const tabs: Array<{
  section: RepoSection;
  label: string;
  to:
    | "/r/$owner/$repo"
    | "/r/$owner/$repo/scheduled-tasks"
    | "/r/$owner/$repo/settings";
  icon: ReactNode;
}> = [
  {
    section: "issues",
    label: "Issues",
    to: "/r/$owner/$repo",
    icon: <CircleDot className="size-4" aria-hidden="true" />,
  },
  {
    section: "scheduled-tasks",
    label: "Scheduled task",
    to: "/r/$owner/$repo/scheduled-tasks",
    icon: <CalendarClock className="size-4" aria-hidden="true" />,
  },
  {
    section: "settings",
    label: "Settings",
    to: "/r/$owner/$repo/settings",
    icon: <Settings className="size-4" aria-hidden="true" />,
  },
];

export function RepoTopbar({ fallback }: { fallback: ReactNode }) {
  const repoState = useRouterState({ select: selectRepoRouteState });

  if (repoState == null) return fallback;

  const { owner, repo, section } = repoState;
  const fullName = `${owner}/${repo}`;

  return (
    <nav
      aria-label="Repository navigation"
      className="flex min-w-0 flex-1 items-center gap-3"
    >
      <Link
        to="/r/$owner/$repo"
        params={{ owner, repo }}
        search={{}}
        activeOptions={{ exact: true }}
        className="min-w-0 shrink rounded-md px-2 py-1 text-sm font-semibold hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="block truncate">{fullName}</span>
      </Link>

      <div
        aria-label={`${fullName} sections`}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-md bg-muted p-0.5"
      >
        {tabs.map((tab) => {
          const active = section === tab.section;
          return (
            <Link
              key={tab.section}
              to={tab.to}
              params={{ owner, repo }}
              search={{}}
              activeOptions={{ exact: true }}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:px-3",
                active && "bg-background text-foreground shadow-sm",
              )}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function selectRepoRouteState(state: {
  location: { pathname: string };
  matches: Array<{ params: Record<string, unknown> }>;
}): RepoRouteState | null {
  let owner: string | undefined;
  let repo: string | undefined;
  for (let i = state.matches.length - 1; i >= 0; i--) {
    const params = state.matches[i].params;
    if (typeof params.owner === "string" && typeof params.repo === "string") {
      owner = params.owner;
      repo = params.repo;
      break;
    }
  }

  if (!owner || !repo) return null;

  const parts = state.location.pathname.split("/").filter(Boolean);
  const section = sectionForPath(parts[3]);

  return { owner, repo, section };
}

function sectionForPath(section: string | undefined): RepoSection | null {
  if (section == null || section === "issues") return "issues";
  if (section === "scheduled-tasks") return "scheduled-tasks";
  if (section === "settings") return "settings";
  return "issues";
}
