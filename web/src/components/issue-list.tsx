// Repo top issue list (/r/:owner/:repo). State tabs + label filters over the
// shared list-row pattern (IssueRow). TanStack Query backed; refetches on
// events via the issues query key (event-keys.ts).

import { Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Loader2,
  Tag,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Issue, Workspace } from "@/api/types";
import { CreateIssueButton } from "@/components/create-issue-button";
import { IssueRow } from "@/components/dashboard-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LABEL_CHIP_BASE_CLASS, labelColorClass } from "@/lib/label-color";
import { cn } from "@/lib/utils";
import { workspacePath } from "@/lib/workspace-path";
import {
  DEFAULT_ISSUE_FILTERS,
  ISSUE_LIST_PAGE_SIZE,
  type IssueListFilters,
  useIssuesList,
  useLabelsList,
} from "@/queries/issues";
import { useRepo } from "@/queries/repos";
import { useWorkspaces } from "@/queries/workspaces";

const STATE_TABS: {
  value: IssueListFilters["state"];
  label: string;
}[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function parseLabelsParam(labels: string): string[] {
  return labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function labelsParamFromList(labels: string[]): string | undefined {
  return labels.length > 0 ? labels.join(",") : undefined;
}

interface IssueSection {
  branch: string;
  issues: Issue[];
  workspace?: Workspace;
  defaultWorkspace?: Workspace;
}

function composeIssueSections(
  issues: Issue[],
  defaultBranch: string,
  workspaces: Workspace[],
): IssueSection[] {
  const defaultGroup: IssueSection = {
    branch: defaultBranch,
    issues: [],
  };
  const activeWorkspaces = workspaces.filter(
    (workspace) => workspace.archived_at === null,
  );
  defaultGroup.defaultWorkspace = activeWorkspaces.find(
    (workspace) => workspace.branch === defaultBranch,
  );
  const nonDefaultWorkspaces = activeWorkspaces.filter(
    (workspace) => workspace.branch !== defaultBranch,
  );
  const workspaceBranches = new Set(
    nonDefaultWorkspaces.map((workspace) => workspace.branch),
  );
  const workspaceIssues = new Map(
    nonDefaultWorkspaces.map((workspace) => [workspace.branch, [] as Issue[]]),
  );
  const unregisteredGroups = new Map<string, Issue[]>();

  for (const issue of issues) {
    const branch = issue.target_branch?.trim();
    if (!branch || branch === defaultBranch) {
      defaultGroup.issues.push(issue);
      continue;
    }
    const groups = workspaceBranches.has(branch)
      ? workspaceIssues
      : unregisteredGroups;
    const group = groups.get(branch);
    if (group) {
      group.push(issue);
    } else {
      groups.set(branch, [issue]);
    }
  }

  const sections: IssueSection[] = [
    defaultGroup,
    ...nonDefaultWorkspaces.map((workspace) => ({
      branch: workspace.branch,
      issues: workspaceIssues.get(workspace.branch) ?? [],
      workspace,
    })),
    ...Array.from(unregisteredGroups, ([branch, groupedIssues]) => ({
      branch,
      issues: groupedIssues,
    })),
  ];

  return sections.filter(
    (section) =>
      section.workspace !== undefined ||
      section.issues.length > 0 ||
      (section === defaultGroup && workspaces.length > 0),
  );
}

export function IssueList({
  owner,
  repo,
  labelsParam,
  stateParam,
  labelFilterMode = "text",
  issueScope,
}: {
  owner: string;
  repo: string;
  /** `labels` search param — seeds the filter so a label chip can deep-link here pre-filtered (#368). */
  labelsParam?: string;
  /** `state` search param — omitted for open, `closed` or `all` for the other tabs. */
  stateParam?: IssueListFilters["state"];
  /** Repo top uses the dropdown requested in #884; secondary issue lists keep the legacy text filter. */
  labelFilterMode?: "text" | "select";
  /** Limits the shared list to issues outside workspaces or in one workspace. */
  issueScope?: "unassigned" | { workspace: string };
}) {
  const labels = labelsParam ?? "";
  const state = stateParam ?? DEFAULT_ISSUE_FILTERS.state;
  const filters = useMemo<IssueListFilters>(
    () => ({
      ...DEFAULT_ISSUE_FILTERS,
      state,
      labels,
    }),
    [state, labels],
  );
  const [draftLabels, setDraftLabels] = useState(labelsParam ?? "");
  const query = useIssuesList(owner, repo, filters);
  const labelsQuery = useLabelsList(owner, repo, labelFilterMode === "select");
  const repoQuery = useRepo(owner, repo);
  const workspacesQuery = useWorkspaces(owner, repo);
  const navigate = useNavigate();
  const allVisibleIssues = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((page) => page.slice(0, ISSUE_LIST_PAGE_SIZE));
  }, [query.data]);
  const defaultBranch = repoQuery.data?.default_branch ?? "main";
  const workspaces = Array.isArray(workspacesQuery.data)
    ? workspacesQuery.data
    : [];
  const visibleIssues = useMemo(() => {
    if (!issueScope) return allVisibleIssues;
    if (issueScope !== "unassigned") {
      return allVisibleIssues.filter(
        (issue) => issue.target_branch === issueScope.workspace,
      );
    }
    const workspaceBranches = new Set(
      workspaces
        .filter((workspace) => workspace.archived_at === null)
        .map((workspace) => workspace.branch),
    );
    return allVisibleIssues.filter((issue) => {
      const branch = issue.target_branch?.trim();
      return !branch || !workspaceBranches.has(branch);
    });
  }, [allVisibleIssues, issueScope, workspaces]);
  const issueSections = useMemo(
    () => composeIssueSections(visibleIssues, defaultBranch, workspaces),
    [visibleIssues, defaultBranch, workspaces],
  );

  // The `labels` URL param is the single source of truth for the labels filter,
  // so a label chip elsewhere and the Apply button below agree and the filtered
  // list is shareable/bookmarkable. This effect mirrors the param into the live
  // filter and the input draft whenever it changes (chip click on this same
  // page, back/forward, reload).
  useEffect(() => {
    setDraftLabels(labels);
  }, [labels]);

  // Apply commits the draft to the URL (not directly to state) — the effect
  // above then applies it. Keeps the URL authoritative so a reload/share keeps
  // the same filter; an empty box drops the param entirely.
  function apply() {
    const search = {
      labels: draftLabels.trim() || undefined,
      state: state === "open" ? undefined : state,
    };
    if (issueScope && issueScope !== "unassigned") {
      navigate({
        to: "/r/w/$workspaceName",
        params: { workspaceName: issueScope.workspace },
        search,
      });
    } else {
      navigate({
        to: "/r/$owner/$repo",
        params: { owner, repo },
        search,
      });
    }
  }

  const selectedLabels = useMemo(() => parseLabelsParam(labels), [labels]);

  function navigateWithLabels(nextLabels: string[]) {
    const search = {
      labels: labelsParamFromList(nextLabels),
      state: state === "open" ? undefined : state,
    };
    if (issueScope && issueScope !== "unassigned") {
      navigate({
        to: "/r/w/$workspaceName",
        params: { workspaceName: issueScope.workspace },
        search,
      });
    } else {
      navigate({
        to: "/r/$owner/$repo",
        params: { owner, repo },
        search,
      });
    }
  }

  function addSelectedLabel(nextLabel: string) {
    if (!nextLabel || selectedLabels.includes(nextLabel)) return;
    navigateWithLabels([...selectedLabels, nextLabel]);
  }

  function removeSelectedLabel(labelToRemove: string) {
    navigateWithLabels(
      selectedLabels.filter((label) => label !== labelToRemove),
    );
  }

  function toggleSelectedLabel(labelToToggle: string) {
    if (selectedLabels.includes(labelToToggle)) {
      removeSelectedLabel(labelToToggle);
    } else {
      addSelectedLabel(labelToToggle);
    }
  }

  const labelOptions = labelsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-content flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Issue state"
          className="inline-flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto rounded-md border bg-muted p-0.5"
        >
          {STATE_TABS.map((tab) => {
            const active = state === tab.value;
            const search = {
              labels: labels || undefined,
              state: tab.value === "open" ? undefined : tab.value,
            };
            const linkProps =
              issueScope && issueScope !== "unassigned"
                ? {
                    to: "/r/w/$workspaceName" as const,
                    params: { workspaceName: issueScope.workspace },
                    search,
                  }
                : {
                    to: "/r/$owner/$repo" as const,
                    params: { owner, repo },
                    search,
                  };
            return (
              <Link
                key={tab.value}
                role="tab"
                aria-selected={active}
                {...linkProps}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center justify-center rounded-sm px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  active
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        {labelFilterMode === "select" ? (
          <div className="flex min-h-9 min-w-64 flex-1 flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  aria-label="Label filter"
                  className="h-9 min-w-36 justify-between gap-2 border bg-background px-3 font-normal shadow-sm"
                  disabled={labelsQuery.isLoading}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">Labels</span>
                    {selectedLabels.length > 0 ? (
                      <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                        {selectedLabels.length}
                      </span>
                    ) : null}
                  </span>
                  <ChevronsUpDown
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-[min(20rem,calc(100vh-5rem))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 overflow-y-auto"
              >
                <DropdownMenuLabel>Filter by label</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {labelOptions.length > 0 ? (
                  labelOptions.map((label) => {
                    const selected = selectedLabels.includes(label.name);
                    return (
                      // menuitemcheckbox exposes the selection state to assistive
                      // tech (aria-checked); preventDefault keeps the menu open so
                      // several labels can be toggled without reopening — the
                      // standard multi-select combobox behaviour.
                      <DropdownMenuCheckboxItem
                        key={label.name}
                        checked={selected}
                        className="gap-2"
                        onSelect={(event) => {
                          event.preventDefault();
                          toggleSelectedLabel(label.name);
                        }}
                      >
                        <Check
                          className={cn(
                            "size-4 shrink-0",
                            selected ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden="true"
                        />
                        <span
                          className={cn(
                            LABEL_CHIP_BASE_CLASS,
                            labelColorClass(label.name),
                            "max-w-56",
                          )}
                        >
                          <span className="truncate">{label.name}</span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    );
                  })
                ) : (
                  <DropdownMenuItem disabled>
                    No labels available
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedLabels.length > 0 ? (
              <div
                aria-label="Selected labels"
                className="flex min-w-0 flex-wrap items-center gap-1"
              >
                {selectedLabels.map((label) => (
                  <span
                    key={label}
                    className={cn(
                      LABEL_CHIP_BASE_CLASS,
                      labelColorClass(label),
                      "h-6 max-w-48 gap-1 pr-1",
                    )}
                  >
                    <span className="truncate">{label}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${label} label filter`}
                      onClick={() => removeSelectedLabel(label)}
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/15"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  aria-label="Clear label filters"
                  onClick={() => navigateWithLabels([])}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                  Clear
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <input
              aria-label="Labels filter"
              placeholder="Labels (comma-separated)"
              value={draftLabels}
              onChange={(e) => setDraftLabels(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
              }}
              className="h-9 min-w-48 flex-1 rounded-md border bg-background px-2 text-sm"
            />
            <Button variant="secondary" onClick={apply}>
              Apply
            </Button>
          </>
        )}
        <CreateIssueButton
          repo={`${owner}/${repo}`}
          targetBranch={
            issueScope && issueScope !== "unassigned"
              ? issueScope.workspace
              : undefined
          }
        />
      </div>

      {query.isLoading || repoQuery.isLoading || workspacesQuery.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : query.isError || repoQuery.isError || workspacesQuery.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load.
          {query.error instanceof Error ? ` ${query.error.message}` : null}
          {repoQuery.error instanceof Error
            ? ` ${repoQuery.error.message}`
            : null}
          {workspacesQuery.error instanceof Error
            ? ` ${workspacesQuery.error.message}`
            : null}
        </div>
      ) : visibleIssues.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            {state === "closed"
              ? "No closed issues."
              : state === "all"
                ? "No issues."
                : "No open issues."}
          </p>
          <IssueListLoadMore query={query} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {issueScope ? (
            <ul className="flex flex-col divide-y rounded-md border">
              {visibleIssues.map((issue) => (
                <li key={issue.number}>
                  <IssueRow
                    owner={owner}
                    repo={repo}
                    issue={issue}
                    labelState={state}
                    labelWorkspace={
                      issueScope !== "unassigned"
                        ? issueScope?.workspace
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            issueSections.map((section) =>
              section.workspace || section.defaultWorkspace ? (
                <Link
                  key={section.branch}
                  to={workspacePath(section.branch)}
                  className="flex items-center justify-between gap-3 rounded-md border p-4 transition-colors hover:bg-accent"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {section.branch}
                    <Badge>workspace</Badge>
                    {section.workspace && !section.workspace.branch_exists ? (
                      <Badge tone="review-changes">
                        <AlertTriangle className="mr-1 size-3" /> branch missing
                      </Badge>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Open workspace
                  </span>
                </Link>
              ) : (
                <section key={section.branch} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                      {section.branch}
                      {section.workspace ? <Badge>workspace</Badge> : null}
                      {section.defaultWorkspace ? (
                        <span className="text-xs font-normal">
                          workspace registered as default branch
                        </span>
                      ) : null}
                      {section.workspace && !section.workspace.branch_exists ? (
                        <Badge tone="review-changes">
                          <AlertTriangle className="mr-1 size-3" /> branch
                          missing
                        </Badge>
                      ) : null}
                    </h2>
                  </div>
                  {section.workspace && !section.workspace.branch_exists ? (
                    <p className="rounded-md border border-amber-500/50 bg-amber-500/5 p-3 text-sm text-muted-foreground">
                      Recreate the branch or archive this workspace.
                    </p>
                  ) : null}
                  {section.issues.length === 0 &&
                  (!section.workspace || section.workspace.branch_exists) ? (
                    <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                      No issues yet
                    </p>
                  ) : section.issues.length > 0 ? (
                    <ul className="flex flex-col divide-y rounded-md border">
                      {section.issues.map((issue) => (
                        <li key={issue.number}>
                          <IssueRow
                            owner={owner}
                            repo={repo}
                            issue={issue}
                            labelState={state}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              ),
            )
          )}
          <IssueListLoadMore query={query} />
        </div>
      )}
    </div>
  );
}

function IssueListLoadMore({
  query,
}: {
  query: ReturnType<typeof useIssuesList>;
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="flex justify-center">
      <Button
        variant="secondary"
        onClick={() => query.fetchNextPage()}
        disabled={query.isFetchingNextPage}
      >
        {query.isFetchingNextPage ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : null}
        Load more
      </Button>
    </div>
  );
}
