import { createRootRoute } from "@tanstack/react-router";
import { useLoopHubEvents } from "@/lib/use-loophub-events";
import { AppLayout } from "@/components/app-layout";

function RootLayout() {
  // SSE -> query invalidation lives at the root so every route stays live.
  useLoopHubEvents();
  return <AppLayout />;
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
