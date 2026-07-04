import { createRootRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/app-layout";
import { useLoopHubEvents } from "@/lib/use-loophub-events";

function RootLayout() {
  // Event polling -> query invalidation lives at the root so every route stays live.
  useLoopHubEvents();
  return <AppLayout />;
}

export const rootRoute = createRootRoute({
  component: RootLayout,
});
