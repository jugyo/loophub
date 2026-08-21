// App shell: fixed top navigation + main content area with route-level navigation.
// Routes render into <Outlet/>. Screen content lands in later UI issues.

import { Outlet } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AppStatusbar } from "@/components/app-statusbar";
import { AppTopbar } from "@/components/app-topbar";
import { ComponentDebugOverlay } from "@/components/component-debug-overlay";
import {
  DebugLogPanel,
  DebugPanelProvider,
  DebugPanelToggle,
} from "@/components/debug-panel";
import { NotificationStack } from "@/components/notification-stack";
import { RepoHerdrWarning } from "@/components/repo-herdr-warning";
import { RepoSwitcher } from "@/components/repo-switcher";
import { RepoTopbar } from "@/components/repo-topbar";
import {
  TerminalControllerProvider,
  TerminalLaunchErrorDialog,
} from "@/components/terminal-controller";
import { ToastProvider, ToastViewport } from "@/components/toast";
import { WorkerCompatibilityWarning } from "@/components/worker-compatibility-warning";
import { useNotificationSound } from "@/lib/use-notification-sound";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

export function AppLayout() {
  // Reset the content scroll position to the top on every route change (#277).
  const mainRef = useRef<HTMLElement>(null);
  const [repoSwitcherRequest, setRepoSwitcherRequest] = useState(0);
  useScrollToTop(mainRef);
  // Announce arriving notifications from the shell: the stack below only renders them.
  useNotificationSound();
  return (
    // TerminalControllerProvider wraps the content so terminal launch buttons can
    // launch a Herdr session via useTerminalLauncher() and surface its launch feedback / error
    // dialog here at the shell level.
    <TerminalControllerProvider>
      <ToastProvider>
        <DebugPanelProvider>
          {/* relative + overflow-hidden makes the shell the containing block for any
              position:absolute descendants (e.g. Tailwind sr-only labels). Without a
              positioned ancestor those elements resolve against the initial containing
              block, so a label whose static position sits below the viewport expands
              document scrollHeight and yields a second vertical scrollbar beside main. */}
          <div
            data-debug-component="AppLayout"
            className="relative flex h-screen w-full flex-col overflow-hidden bg-background text-foreground"
          >
            <AppTopbar
              onOpenRepoSwitcher={() =>
                setRepoSwitcherRequest((request) => request + 1)
              }
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <RepoTopbar />
              <WorkerCompatibilityWarning />
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
              <DebugLogPanel />
            </div>
            <AppStatusbar debugPanel={<DebugPanelToggle />} />
            <RepoSwitcher openRequest={repoSwitcherRequest} />
            <TerminalLaunchErrorDialog />
            <NotificationStack />
            {/* Operation feedback (#574): a floating toast above the content, with an explicit
                lifetime independent of any one screen's components (mirrors the old ErrorBanner). */}
            <ToastViewport />
            <ComponentDebugOverlay />
          </div>
        </DebugPanelProvider>
      </ToastProvider>
    </TerminalControllerProvider>
  );
}
