import {
  createRootRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import { AppLayout } from "@/components/app-layout";
import { useLoopHubEvents } from "@/lib/use-loophub-events";

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  // Event polling -> query invalidation lives at the root so every route stays live.
  useLoopHubEvents();

  if (pathname === "/__ui") {
    return <Outlet />;
  }

  return <AppLayout />;
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
