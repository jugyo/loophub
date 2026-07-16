import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";
import { NewWorkspaceButton } from "@/components/new-workspace-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { workspacePath } from "@/lib/workspace-path";
import { useRepo } from "@/queries/repos";
import { useWorkspaces } from "@/queries/workspaces";

export function WorkspacePicker({
  owner,
  repo,
  selectedBranch,
}: {
  owner: string;
  repo: string;
  selectedBranch?: string;
}) {
  const navigate = useNavigate();
  const repoQuery = useRepo(owner, repo);
  const workspaces = useWorkspaces(owner, repo);
  const active = (Array.isArray(workspaces.data) ? workspaces.data : []).filter(
    (workspace) => workspace.archived_at === null,
  );
  const defaultBranch = repoQuery.data?.default_branch;

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            className="min-w-44 justify-between"
            disabled={workspaces.isLoading || repoQuery.isLoading}
          >
            <span className="truncate">
              {selectedBranch ?? defaultBranch ?? "Workspaces"}
            </span>
            <ChevronsUpDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          <DropdownMenuLabel>Select workspace</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {workspaces.isError || repoQuery.isError ? (
            <DropdownMenuItem disabled>
              Failed to load workspaces
            </DropdownMenuItem>
          ) : (
            <>
              {defaultBranch ? (
                <DropdownMenuItem
                  onSelect={() =>
                    navigate({
                      to: "/r/$owner/$repo",
                      params: { owner, repo },
                    })
                  }
                >
                  {defaultBranch}
                </DropdownMenuItem>
              ) : null}
              {active.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.branch}
                  onSelect={() =>
                    navigate({ href: workspacePath(workspace.branch) })
                  }
                >
                  {workspace.branch}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewWorkspaceButton owner={owner} repo={repo} />
    </div>
  );
}
