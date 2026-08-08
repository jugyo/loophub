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
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Issue, Workspace } from "@/api/types";
import { CreateIssueButton } from "@/components/create-issue-button";
import { IssueRow } from "@/components/dashboard-rows";
import { NewWorkspaceButton } from "@/components/new-workspace-button";
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
import {
  DEFAULT_ISSUE_FILTERS,
  ISSUE_LIST_PAGE_SIZE,
  type IssueListFilters,
  useIssueListPage,
} from "@/queries/issues";

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
  workspaceParam,
  showWorkspaceFilter = false,
  labelFilterMode = "text",
}: {
  owner: string;
  repo: string;
  /** `labels` search param — seeds the filter so a label chip can deep-link here pre-filtered (#368). */
  labelsParam?: string;
  /** `state` search param — omitted for open, `closed` or `all` for the other tabs. */
  stateParam?: IssueListFilters["state"];
  /** `workspace` search param — omitted means All; the default branch selects unassigned + explicit-default issues (#1494). */
  workspaceParam?: string;
  /** Integrates the workspace selector with the repo-top state and label filters (#1494). */
  showWorkspaceFilter?: boolean;
  /** Repo top uses the dropdown requested in #884; secondary issue lists keep the legacy text filter. */
  labelFilterMode?: "text" | "select";
}) {
  const labels = labelsParam ?? "";
  const state = stateParam ?? DEFAULT_ISSUE_FILTERS.state;
  const filters = useMemo<IssueListFilters>(
    () => ({
      ...DEFAULT_ISSUE_FILTERS,
      state,
      labels,
      workspace: showWorkspaceFilter ? workspaceParam : undefined,
    }),
    [state, labels, showWorkspaceFilter, workspaceParam],
  );
  const [draftLabels, setDraftLabels] = useState(labelsParam ?? "");
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const query = useIssueListPage(owner, repo, filters, {
    includeLabels: labelFilterMode === "select",
  });
  const navigate = useNavigate();
  const allVisibleIssues = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((page) => page.issues.slice(0, ISSUE_LIST_PAGE_SIZE));
  }, [query.data]);
  const pageData = query.data?.pages[0];
  const defaultBranch = pageData?.repo.default_branch ?? "main";
  const workspaces = pageData?.workspaces ?? [];
  const activeWorkspaces = workspaces.filter(
    (workspace) => workspace.archived_at === null,
  );
  const visibleIssues = allVisibleIssues;
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
    navigate({
      to: "/r/$owner/$repo",
      params: { owner, repo },
      search: {
        labels: draftLabels.trim() || undefined,
        state: state === "open" ? undefined : state,
        workspace: showWorkspaceFilter ? workspaceParam : undefined,
      },
    });
  }

  const selectedLabels = useMemo(() => parseLabelsParam(labels), [labels]);

  function navigateWithLabels(nextLabels: string[]) {
    navigate({
      to: "/r/$owner/$repo",
      params: { owner, repo },
      search: {
        labels: labelsParamFromList(nextLabels),
        state: state === "open" ? undefined : state,
        workspace: showWorkspaceFilter ? workspaceParam : undefined,
      },
    });
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

  const labelOptions = pageData?.labels ?? [];

  return (
    <div
      data-debug-component="IssueList"
      className="mx-auto flex max-w-content flex-col gap-4"
    >
      <div
        data-debug-component="IssueListFilters"
        className="flex flex-wrap items-start gap-2"
      >
        {showWorkspaceFilter ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  aria-label="Workspace filter"
                  className="h-9 min-w-40 justify-between gap-2 border bg-background px-3 font-normal shadow-sm"
                  disabled={query.isLoading}
                >
                  <span className="truncate">
                    {workspaceParam ?? "All workspaces"}
                  </span>
                  <ChevronsUpDown
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56">
                <DropdownMenuLabel>Filter by workspace</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {query.isError ? (
                  <DropdownMenuItem disabled>
                    Failed to load workspaces
                  </DropdownMenuItem>
                ) : (
                  // All (undefined) + the implicit default branch + each active
                  // workspace, archived excluded. The default branch stands for
                  // unassigned issues too.
                  [
                    undefined,
                    defaultBranch,
                    ...activeWorkspaces
                      .map((workspace) => workspace.branch)
                      .filter((branch) => branch !== defaultBranch),
                  ].map((branch) => (
                    <DropdownMenuItem
                      key={branch ?? "all"}
                      onSelect={() =>
                        navigate({
                          to: "/r/$owner/$repo",
                          params: { owner, repo },
                          search: {
                            labels: labels || undefined,
                            state: state === "open" ? undefined : state,
                            workspace: branch,
                          },
                        })
                      }
                    >
                      {branch ?? "All"}
                      {branch === defaultBranch ? " (default)" : ""}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                {/* The legacy "+ New" trigger lived inside the menu, but the
                  dialog it opened was then trapped in the menu's focus scope
                  (#67): the body is pointer-locked and focus cannot reach the
                  form, so it closed the moment you clicked inside. The dialog
                  is instead controlled from this item and rendered as a sibling
                  below the dropdown, outside the menu's focus scope. */}
                <DropdownMenuItem onSelect={() => setNewWorkspaceOpen(true)}>
                  New workspace
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <NewWorkspaceButton
              owner={owner}
              repo={repo}
              open={newWorkspaceOpen}
              onOpenChange={setNewWorkspaceOpen}
            />
          </>
        ) : null}
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
              workspace: showWorkspaceFilter ? workspaceParam : undefined,
            };
            return (
              <Link
                key={tab.value}
                role="tab"
                aria-selected={active}
                to="/r/$owner/$repo"
                params={{ owner, repo }}
                search={search}
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
                  disabled={query.isLoading}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">
                      {selectedLabels.length === 0
                        ? "Labels"
                        : selectedLabels.length === 1
                          ? selectedLabels[0]
                          : `${selectedLabels.length} selected`}
                    </span>
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
                <DropdownMenuLabel className="flex items-center justify-between gap-2">
                  <span>Filter by label</span>
                  {selectedLabels.length > 0 ? (
                    <button
                      type="button"
                      aria-label="Clear label filters"
                      className="font-normal text-primary hover:underline"
                      onClick={() => navigateWithLabels([])}
                    >
                      Clear
                    </button>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {query.isError ? (
                  <DropdownMenuItem disabled>
                    Failed to load labels
                  </DropdownMenuItem>
                ) : labelOptions.length > 0 ? (
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
                        className="gap-2 pl-2"
                        onSelect={(event) => {
                          event.preventDefault();
                          toggleSelectedLabel(label.name);
                        }}
                      >
                        <span
                          className={cn(
                            LABEL_CHIP_BASE_CLASS,
                            labelColorClass(label.name),
                            "max-w-56",
                          )}
                        >
                          <span className="truncate">{label.name}</span>
                        </span>
                        <Check
                          className={cn(
                            "ml-auto size-4 shrink-0",
                            selected ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden="true"
                        />
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
          targetBranch={showWorkspaceFilter ? workspaceParam : undefined}
        />
      </div>

      {query.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : query.isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load.
          {query.error instanceof Error ? ` ${query.error.message}` : null}
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
          {showWorkspaceFilter ? (
            <ul className="flex flex-col divide-y rounded-md border">
              {visibleIssues.map((issue) => (
                <li key={issue.number}>
                  <IssueRow
                    owner={owner}
                    repo={repo}
                    issue={issue}
                    labelState={state}
                    labelWorkspaceFilter={
                      showWorkspaceFilter ? workspaceParam : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            issueSections.map((section) => (
              <section
                key={section.branch}
                data-debug-component="IssueWorkspaceSection"
                className="flex flex-col gap-2"
              >
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
                        <AlertTriangle className="mr-1 size-3" /> branch missing
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
            ))
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
  query: ReturnType<typeof useIssueListPage>;
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
