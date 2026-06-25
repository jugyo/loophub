// App shell: fixed sidebar + main content area with a breadcrumb header.
// Routes render into <Outlet/>. Screen content lands in later UI issues.

import { Outlet } from "@tanstack/react-router";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { DetailTitleProvider } from "@/components/detail-title";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppLayout() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <AppSidebar />
      <DetailTitleProvider>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-4 border-b px-6">
            <AppBreadcrumb />
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            <Outlet />
          </main>
        </div>
      </DetailTitleProvider>
    </div>
  );
}
