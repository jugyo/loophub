import { AlertTriangle, Ellipsis, Loader2 } from "lucide-react";
import { CreateIssueButton } from "@/components/create-issue-button";
import { IssueRow } from "@/components/dashboard-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_ISSUE_FILTERS, useIssuesList } from "@/queries/issues";
import {
  useSetWorkspaceArchived,
  useWorkspaceResolution,
} from "@/queries/workspaces";

export function WorkspacePage({ workspaceName }: { workspaceName: string }) {
  const resolution = useWorkspaceResolution(workspaceName);

  if (resolution.isLoading) {
    return (
      <div className="mx-auto flex max-w-content items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading workspace…
      </div>
    );
  }
  if (resolution.isError) {
    const status =
      resolution.error &&
      typeof resolution.error === "object" &&
      "status" in resolution.error
        ? resolution.error.status
        : null;
    return (
      <WorkspaceMessage
        title={
          status === 404
            ? "Workspace not found"
            : status === 409
              ? "Workspace name is ambiguous"
              : "Failed to load workspace"
        }
        detail={
          status === 404
            ? `No active workspace named “${workspaceName}” exists.`
            : status === 409
              ? `More than one repository has an active workspace named “${workspaceName}”.`
              : undefined
        }
      />
    );
  }

  const { repo, workspace } = resolution.data!;
  return (
    <ResolvedWorkspacePage
      owner={repo.owner.login}
      repo={repo.name}
      defaultBranch={repo.default_branch}
      workspace={workspace}
    />
  );
}

function ResolvedWorkspacePage({
  owner,
  repo,
  defaultBranch,
  workspace,
}: {
  owner: string;
  repo: string;
  defaultBranch: string;
  workspace: {
    branch: string;
    branch_exists: boolean;
  };
}) {
  const issues = useIssuesList(owner, repo, DEFAULT_ISSUE_FILTERS);
  const archive = useSetWorkspaceArchived(owner, repo);
  const visibleIssues = (issues.data?.pages ?? []).flat();
  const workspaceIssues = visibleIssues.filter(
    (issue) =>
      issue.target_branch === workspace.branch ||
      (workspace.branch === defaultBranch && !issue.target_branch),
  );

  return (
    <div className="mx-auto flex max-w-content flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{workspace.branch}</h1>
            <Badge>workspace</Badge>
            {!workspace.branch_exists ? (
              <Badge tone="review-changes">
                <AlertTriangle className="mr-1 size-3" /> branch missing
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {owner}/{repo}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {archive.error ? (
            <span className="text-xs text-destructive">
              {String(archive.error)}
            </span>
          ) : null}
          <CreateIssueButton
            repo={`${owner}/${repo}`}
            targetBranch={workspace.branch}
            disabled={!workspace.branch_exists}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Workspace actions for ${workspace.branch}`}
                disabled={archive.isPending}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  archive.mutate({ branch: workspace.branch, archived: true })
                }
              >
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {!workspace.branch_exists ? (
        <WorkspaceMessage
          title="Workspace branch is missing"
          detail="Recreate the branch or archive this workspace from repository settings."
        />
      ) : issues.isLoading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading issues…
        </div>
      ) : issues.isError ? (
        <WorkspaceMessage title="Failed to load workspace issues" />
      ) : workspaceIssues.length === 0 ? (
        <>
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No issues yet
          </p>
          <WorkspaceLoadMore issues={issues} />
        </>
      ) : (
        <>
          <ul className="flex flex-col divide-y rounded-md border">
            {workspaceIssues.map((issue) => (
              <li key={issue.number}>
                <IssueRow owner={owner} repo={repo} issue={issue} />
              </li>
            ))}
          </ul>
          <WorkspaceLoadMore issues={issues} />
        </>
      )}
    </div>
  );
}

function WorkspaceLoadMore({
  issues,
}: {
  issues: ReturnType<typeof useIssuesList>;
}) {
  if (!issues.hasNextPage) return null;
  return (
    <div className="flex justify-center">
      <Button
        variant="secondary"
        onClick={() => issues.fetchNextPage()}
        disabled={issues.isFetchingNextPage}
      >
        {issues.isFetchingNextPage ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : null}
        Load more
      </Button>
    </div>
  );
}

function WorkspaceMessage({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="mx-auto max-w-content rounded-md border border-dashed p-6 text-center">
      <h1 className="font-semibold">{title}</h1>
      {detail ? (
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}
