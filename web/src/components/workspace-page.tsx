import { Loader2 } from "lucide-react";
import { IssueList } from "@/components/issue-list";
import { RepositorySearch } from "@/components/repository-search";
import { WorkspacePicker } from "@/components/workspace-picker";
import type { IssueListFilters } from "@/queries/issues";
import { useWorkspaceResolution } from "@/queries/workspaces";

export function WorkspacePage({
  workspaceName,
  labels,
  state,
}: {
  workspaceName: string;
  labels?: string;
  state?: IssueListFilters["state"];
}) {
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
      workspace={workspace}
      labels={labels}
      state={state}
    />
  );
}

function ResolvedWorkspacePage({
  owner,
  repo,
  workspace,
  labels,
  state,
}: {
  owner: string;
  repo: string;
  workspace: {
    branch: string;
    branch_exists: boolean;
  };
  labels?: string;
  state?: IssueListFilters["state"];
}) {
  return (
    <div className="space-y-4">
      <div className="mx-auto flex max-w-content items-center justify-between gap-3">
        <WorkspacePicker
          owner={owner}
          repo={repo}
          selectedBranch={workspace.branch}
        />
        <RepositorySearch owner={owner} repo={repo} />
      </div>
      {!workspace.branch_exists ? (
        <WorkspaceMessage
          title="Workspace branch is missing"
          detail="Recreate the branch or archive this workspace from repository settings."
        />
      ) : (
        <IssueList
          owner={owner}
          repo={repo}
          labelsParam={labels}
          stateParam={state}
          labelFilterMode="select"
          issueScope={{ workspace: workspace.branch }}
        />
      )}
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
