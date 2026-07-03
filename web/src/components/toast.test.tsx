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
import { ToastProvider, ToastViewport, useToast } from "./toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// A tiny harness: buttons that raise a success/error toast, plus a "go" button that navigates to
// a second route. Both the viewport and the controls live under one ToastProvider/router so a
// navigation is a real route change for the provider's clear-on-route-change effect.
function Controls() {
  const { showError, showSuccess } = useToast();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => showError("Merge failed: boom")}>
        show error
      </button>
      <button
        type="button"
        onClick={() => showSuccess("Launched in jugyo-loophub-deadbeef.")}
      >
        show success
      </button>
      {/* Use a real registered app route so the typed navigate() type-checks under the web build. */}
      <button type="button" onClick={() => navigate({ to: "/archived" })}>
        go
      </button>
    </>
  );
}

function renderToasts() {
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <ToastViewport />
        <Outlet />
      </ToastProvider>
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

describe("Toast", () => {
  it("shows an error toast and dismisses it via the close button", async () => {
    renderToasts();

    fireEvent.click(await screen.findByRole("button", { name: "show error" }));
    expect(screen.getByText("Merge failed: boom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Dismiss error/i }));
    expect(screen.queryByText("Merge failed: boom")).toBeNull();
  });

  it("shows a success toast and dismisses it via the close button", async () => {
    renderToasts();

    fireEvent.click(
      await screen.findByRole("button", { name: "show success" }),
    );
    expect(
      screen.getByText("Launched in jugyo-loophub-deadbeef."),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Dismiss notification/i }),
    );
    expect(
      screen.queryByText("Launched in jugyo-loophub-deadbeef."),
    ).toBeNull();
  });

  it("shows both an error and a success toast at once", async () => {
    renderToasts();

    fireEvent.click(await screen.findByRole("button", { name: "show error" }));
    fireEvent.click(screen.getByRole("button", { name: "show success" }));

    expect(screen.getByText("Merge failed: boom")).toBeTruthy();
    expect(
      screen.getByText("Launched in jugyo-loophub-deadbeef."),
    ).toBeTruthy();
  });

  it("auto-dismisses an error toast after 8s and a success toast after 12s", async () => {
    // shouldAdvanceTime keeps real time flowing so Testing Library's async queries still resolve,
    // while advanceTimersByTime lets us jump the auto-dismiss timeouts deterministically.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderToasts();

    fireEvent.click(await screen.findByRole("button", { name: "show error" }));
    fireEvent.click(screen.getByRole("button", { name: "show success" }));

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    await waitFor(() => {
      expect(screen.queryByText("Merge failed: boom")).toBeNull();
    });
    expect(
      screen.getByText("Launched in jugyo-loophub-deadbeef."),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    await waitFor(() => {
      expect(
        screen.queryByText("Launched in jugyo-loophub-deadbeef."),
      ).toBeNull();
    });
  });

  it("clears toasts on route change (context leave)", async () => {
    renderToasts();

    fireEvent.click(await screen.findByRole("button", { name: "show error" }));
    expect(screen.getByText("Merge failed: boom")).toBeTruthy();

    // Navigating to another route is leaving the operation's context: the toast must not persist.
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("other page")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Merge failed: boom")).toBeNull();
    });
  });
});
