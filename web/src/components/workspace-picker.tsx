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
import { useWorkspaces } from "@/queries/workspaces";

export function WorkspacePicker({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const navigate = useNavigate();
  const workspaces = useWorkspaces(owner, repo);
  const active = (Array.isArray(workspaces.data) ? workspaces.data : []).filter(
    (workspace) => workspace.archived_at === null,
  );

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            className="min-w-44 justify-between"
            disabled={workspaces.isLoading}
          >
            <span className="truncate">Workspaces</span>
            <ChevronsUpDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          <DropdownMenuLabel>Select workspace</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {workspaces.isError ? (
            <DropdownMenuItem disabled>
              Failed to load workspaces
            </DropdownMenuItem>
          ) : active.length === 0 ? (
            <DropdownMenuItem disabled>No workspaces</DropdownMenuItem>
          ) : (
            active.map((workspace) => (
              <DropdownMenuItem
                key={workspace.branch}
                onSelect={() =>
                  navigate({ href: workspacePath(workspace.branch) })
                }
              >
                {workspace.branch}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewWorkspaceButton owner={owner} repo={repo} />
    </div>
  );
}
