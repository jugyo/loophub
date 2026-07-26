import { createRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { rootRoute } from "./root";

function SessionsRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate({ to: "/stats", replace: true });
  }, [navigate]);

  return (
    <div
      data-debug-component="SessionsRedirect"
      className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" /> Opening agent sessions…
    </div>
  );
}

export const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionsRedirect,
});
