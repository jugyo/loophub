// Sidebar: active repo list (GET /user/repos, archived excluded — same as v1),
// plus links to Home and Archived. Repo screens land in later UI issues.

import { Link } from "@tanstack/react-router";
import { Archive, Home, Loader2 } from "lucide-react";
import { useRepos } from "@/queries/repos";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  const { data: repos, isLoading, isError } = useRepos();

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <Link to="/" className="text-lg font-semibold">
          LoopHub
        </Link>
      </div>

      <nav className="flex flex-col gap-1 p-2">
        <SidebarLink to="/" icon={<Home className="size-4" />}>
          Home
        </SidebarLink>
        <SidebarLink to="/archived" icon={<Archive className="size-4" />}>
          Archived
        </SidebarLink>
      </nav>

      <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Repositories
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {isLoading && (
          <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {isError && (
          <div className="px-2 py-2 text-sm text-destructive">
            Failed to load repositories.
          </div>
        )}
        {repos?.length === 0 && (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            No repositories.
          </div>
        )}
        {repos?.map((repo) => {
          const [owner, name] = repo.full_name.split("/");
          return (
            <SidebarLink
              key={repo.id}
              to={`/r/${owner}/${name}`}
              title={repo.full_name}
            >
              <span className="truncate">{repo.name}</span>
            </SidebarLink>
          );
        })}
      </div>
    </aside>
  );
}

function SidebarLink({
  to,
  icon,
  title,
  children,
}: {
  to: string;
  icon?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={title}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
      )}
      activeProps={{ className: "bg-accent text-accent-foreground font-medium" }}
      activeOptions={{ exact: to === "/" }}
    >
      {icon}
      {children}
    </Link>
  );
}
