// App shell: fixed sidebar + main content area with a breadcrumb header.
// Routes render into <Outlet/>. Screen content lands in later UI issues.

import { Outlet } from "@tanstack/react-router";
import { useRef } from "react";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { CreateIssueButton } from "@/components/create-issue-button";
import { DetailTitleProvider } from "@/components/detail-title";
import { ErrorBanner, ErrorBannerProvider } from "@/components/error-banner";
import { TerminalControllerProvider } from "@/components/terminal-controller";
import { TerminalPane } from "@/components/terminal-pane";
import { ThemeToggle } from "@/components/theme-toggle";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

export function AppLayout() {
  // Reset the content scroll position to the top on every route change (#277).
  const mainRef = useRef<HTMLElement>(null);
  useScrollToTop(mainRef);
  return (
    // The terminal is a fixed full-width overlay along the bottom (see terminal-pane.tsx), so
    // expanding it never reflows the page. The main content reserves bottom space equal to the
    // terminal's current height via the --lh-term-reserve CSS var the pane publishes, so its tail
    // stays scrollable past the terminal whether it is collapsed, dragged, or maximized. The
    // sidebar keeps a static pb-12 — its short list never reaches under an expanded terminal.
    // TerminalControllerProvider wraps both the content and the pane so buttons in the content
    // (New Issue / Build) can open a terminal tab with a command via useTerminal().
    <TerminalControllerProvider>
      <ErrorBannerProvider>
        <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
          <AppSidebar />
          <DetailTitleProvider>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-14 shrink-0 items-center gap-4 border-b px-6">
                <AppBreadcrumb />
                <div className="ml-auto flex items-center gap-2">
                  {/* New Issue lives here so it is reachable from any repo-scoped screen; it
                      hides itself on non-repo screens (home / archived). */}
                  <CreateIssueButton />
                  <ThemeToggle />
                </div>
              </header>
              <main
                ref={mainRef}
                className="min-h-0 flex-1 overflow-y-auto px-6 pt-6"
                style={{ paddingBottom: "var(--lh-term-reserve, 48px)" }}
              >
                {/* Operation-failure feedback (#323): a single in-page banner at the top of the
                    content, with an explicit lifetime independent of any one screen's components. */}
                <ErrorBanner />
                <Outlet />
              </main>
            </div>
          </DetailTitleProvider>
          <TerminalPane />
        </div>
      </ErrorBannerProvider>
    </TerminalControllerProvider>
  );
}
