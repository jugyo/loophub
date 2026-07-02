// App shell: fixed sidebar + main content area with a breadcrumb header.
// Routes render into <Outlet/>. Screen content lands in later UI issues.

import { Outlet } from "@tanstack/react-router";
import { useRef } from "react";
import { AppBreadcrumb } from "@/components/app-breadcrumb";
import { AppSidebar } from "@/components/app-sidebar";
import { CreateIssueButton } from "@/components/create-issue-button";
import { DetailTitleProvider } from "@/components/detail-title";
import { ErrorBanner, ErrorBannerProvider } from "@/components/error-banner";
import {
  TerminalControllerProvider,
  TerminalLaunchErrorDialog,
  TerminalLaunchFeedback,
} from "@/components/terminal-controller";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

export function AppLayout() {
  // Reset the content scroll position to the top on every route change (#277).
  const mainRef = useRef<HTMLElement>(null);
  useScrollToTop(mainRef);
  return (
    // TerminalControllerProvider wraps the content so New Issue / Build / Resume buttons can
    // launch a Herdr session via useTerminalLauncher() and surface its launch feedback / error
    // dialog here at the shell level.
    <TerminalControllerProvider>
      <ErrorBannerProvider>
        <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
          <AppSidebar />
          <DetailTitleProvider>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-14 shrink-0 items-center gap-4 px-6">
                <AppBreadcrumb />
              </header>
              <main
                ref={mainRef}
                className="min-h-0 flex-1 overflow-y-auto px-6 pt-6"
              >
                {/* Operation-failure feedback (#323): a single in-page banner at the top of the
                    content, with an explicit lifetime independent of any one screen's components. */}
                <ErrorBanner />
                <TerminalLaunchFeedback />
                <Outlet />
              </main>
            </div>
          </DetailTitleProvider>
          {/* Floating "New issue" launcher. Fixed-positioned, so it is rendered at the shell level
              rather than inside the header; it hides itself on non-repo screens (home / archived). */}
          <CreateIssueButton />
          <TerminalLaunchErrorDialog />
        </div>
      </ErrorBannerProvider>
    </TerminalControllerProvider>
  );
}
