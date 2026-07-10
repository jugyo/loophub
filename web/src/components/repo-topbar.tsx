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

export function RepoTopbar() {
  const repoState = useRouterState({ select: selectRepoRouteState });

  if (repoState == null) return null;

  const { owner, repo, section } = repoState;

  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b px-4 sm:px-6">
      <nav
        aria-label="Repository navigation"
        className="flex min-w-0 flex-1 items-stretch self-stretch"
      >
        <div
          aria-label="Repository sections"
          className="flex min-w-0 flex-1 items-end gap-1 overflow-hidden border-b border-transparent"
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
                aria-label={tab.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-11 min-w-0 flex-1 basis-0 items-center justify-center gap-1.5 border-b-2 px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:flex-none sm:basis-auto sm:px-3",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {tab.icon}
                <span className="hidden whitespace-nowrap sm:inline">
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
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
