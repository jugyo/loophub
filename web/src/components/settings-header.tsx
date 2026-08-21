import { Link } from "@tanstack/react-router";
import { Bell, Bot, FolderGit2, Settings2, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SettingsSection =
  | "agent"
  | "advanced"
  | "workflows"
  | "repositories"
  | "notifications";

const SETTINGS_NAV_ITEMS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Bot;
  path:
    | "/settings"
    | "/settings/advanced"
    | "/settings/workflows"
    | "/settings/repositories"
    | "/settings/notifications";
}> = [
  {
    id: "agent",
    label: "Agent",
    description: "Default coding agent, model, effort, and cost settings.",
    icon: Bot,
    path: "/settings",
  },
  {
    id: "workflows",
    label: "Workflows",
    description:
      "Global prompt bundles and contract language for development workflows.",
    icon: Workflow,
    path: "/settings/workflows",
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Network access and other advanced instance settings.",
    icon: Settings2,
    path: "/settings/advanced",
  },
  {
    id: "repositories",
    label: "Repositories",
    description: "Repositories registered in LoopHub, including archived ones.",
    icon: FolderGit2,
    path: "/settings/repositories",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "How arriving notifications announce themselves.",
    icon: Bell,
    path: "/settings/notifications",
  },
];

export function SettingsLayout({
  section,
  children,
}: {
  section: SettingsSection;
  children: ReactNode;
}) {
  const current = SETTINGS_NAV_ITEMS.find((item) => item.id === section)!;

  return (
    <div
      data-debug-component="SettingsLayout"
      className="mx-auto flex max-w-content items-start gap-8"
    >
      <aside className="sticky top-6 w-56 shrink-0 border-r pr-6">
        <h1 className="px-3 text-sm font-semibold">Settings</h1>
        <p className="mt-1 px-3 text-xs text-muted-foreground">
          Instance-level settings
        </p>
        <nav aria-label="Settings" className="mt-5 space-y-1">
          {SETTINGS_NAV_ITEMS.map((item) => {
            const active = item.id === section;
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                to={item.path}
                activeOptions={{ exact: true }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div
        role="region"
        aria-labelledby={`settings-${section}-heading`}
        className="min-w-0 flex-1 pb-8"
      >
        <header className="border-b pb-5">
          <h2
            id={`settings-${section}-heading`}
            className="text-xl font-semibold"
          >
            {current.label}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {current.description}
          </p>
        </header>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
