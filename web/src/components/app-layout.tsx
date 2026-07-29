// App shell: fixed top navigation + main content area with route-level navigation.
// Routes render into <Outlet/>. Screen content lands in later UI issues.

import { Outlet } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AppStatusbar } from "@/components/app-statusbar";
import { AppTopbar } from "@/components/app-topbar";
import { ComponentDebugOverlay } from "@/components/component-debug-overlay";
import { NotificationStack } from "@/components/notification-stack";
import { RepoHerdrWarning } from "@/components/repo-herdr-warning";
import { RepoSwitcher } from "@/components/repo-switcher";
import { RepoTopbar } from "@/components/repo-topbar";
import {
  TerminalControllerProvider,
  TerminalLaunchErrorDialog,
} from "@/components/terminal-controller";
import { ToastProvider, ToastViewport } from "@/components/toast";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

export function AppLayout() {
  // Reset the content scroll position to the top on every route change (#277).
  const mainRef = useRef<HTMLElement>(null);
  const [repoSwitcherRequest, setRepoSwitcherRequest] = useState(0);
  useScrollToTop(mainRef);
  return (
    // TerminalControllerProvider wraps the content so New Issue / Build / Resume buttons can
    // launch a Herdr session via useTerminalLauncher() and surface its launch feedback / error
    // dialog here at the shell level.
    <TerminalControllerProvider>
      <ToastProvider>
        <div
          data-debug-component="AppLayout"
          className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground"
        >
          <AppTopbar
            onOpenRepoSwitcher={() =>
              setRepoSwitcherRequest((request) => request + 1)
            }
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <RepoTopbar />
            <RepoHerdrWarning />
            {/* scroll-pt-11 reserves the detail pages' sticky header height (#2033) at the top
                of this scrollport, so anything scrolled to (an anchor jump, scrollIntoView)
                lands below the bar instead of underneath it. */}
            <main
              ref={mainRef}
              data-debug-component="RouteContent"
              className="min-h-0 flex-1 scroll-pt-11 overflow-y-auto px-4 pt-6 sm:px-6"
            >
              <Outlet />
            </main>
          </div>
          <AppStatusbar />
          <RepoSwitcher openRequest={repoSwitcherRequest} />
          <TerminalLaunchErrorDialog />
          <NotificationStack />
          {/* Operation feedback (#574): a floating toast above the content, with an explicit
              lifetime independent of any one screen's components (mirrors the old ErrorBanner). */}
          <ToastViewport />
          <ComponentDebugOverlay />
        </div>
      </ToastProvider>
    </TerminalControllerProvider>
  );
}
