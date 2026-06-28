import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorBanner,
  ErrorBannerProvider,
  useErrorBanner,
} from "./error-banner";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// A tiny harness: a "show" button that raises a banner, plus a "go" button that navigates to a
// second route. Both the banner and the controls live under one ErrorBannerProvider/router so a
// navigation is a real route change for the provider's clear-on-route-change effect.
function Controls() {
  const { showError } = useErrorBanner();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => showError("Merge failed: boom")}>
        show
      </button>
      {/* Use a real registered app route so the typed navigate() type-checks under the web build. */}
      <button type="button" onClick={() => navigate({ to: "/archived" })}>
        go
      </button>
    </>
  );
}

function renderBanner() {
  const rootRoute = createRootRoute({
    component: () => (
      <ErrorBannerProvider>
        <ErrorBanner />
        <Outlet />
      </ErrorBannerProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Controls,
  });
  const otherRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/archived",
    component: () => <div>other page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, otherRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("ErrorBanner", () => {
  it("shows a message and dismisses it via the close button", async () => {
    renderBanner();

    fireEvent.click(await screen.findByRole("button", { name: "show" }));
    expect(screen.getByText("Merge failed: boom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss error/i }));
    expect(screen.queryByText("Merge failed: boom")).toBeNull();
  });

  it("auto-dismisses after the timeout", async () => {
    // shouldAdvanceTime keeps real time flowing so Testing Library's async queries still resolve,
    // while advanceTimersByTime lets us jump the 8s auto-dismiss deterministically.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderBanner();

    fireEvent.click(await screen.findByRole("button", { name: "show" }));
    expect(screen.getByText("Merge failed: boom")).toBeTruthy();

    // Advance past the auto-dismiss timeout (8s).
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    await waitFor(() => {
      expect(screen.queryByText("Merge failed: boom")).toBeNull();
    });
  });

  it("clears the banner on route change (context leave)", async () => {
    renderBanner();

    fireEvent.click(await screen.findByRole("button", { name: "show" }));
    expect(screen.getByText("Merge failed: boom")).toBeTruthy();

    // Navigating to another route is leaving the operation's context: the banner must not persist.
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("other page")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Merge failed: boom")).toBeNull();
    });
  });
});
