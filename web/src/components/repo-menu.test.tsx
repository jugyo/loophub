import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { Repo } from "@/api/types";
import { RepoMenu } from "./repo-menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function repo(archived: boolean): Repo {
  return {
    id: 1,
    name: "proj",
    full_name: "me/proj",
    default_branch: "main",
    local_path: "/tmp/proj",
    archived,
    archived_at: archived ? "2026-06-01T00:00:00Z" : null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function mockFetch(initialArchived: boolean, patchFails = false) {
  return mockRpcFetch({
    "repos/get": () => repo(initialArchived),
    "repos/setArchived": (p) => {
      if (patchFails) throw new RpcFault(500, "boom");
      return repo(p.archived);
    },
  });
}

function renderMenu(initialArchived = false, patchFails = false) {
  vi.stubGlobal("fetch", mockFetch(initialArchived, patchFails));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <RepoMenu owner="me" repo="proj" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// The trigger renders disabled until useRepo resolves (archived state unknown).
// Wait for it to become enabled before interacting.
async function openMenu() {
  const trigger = (await screen.findByRole("button", {
    name: /repository actions/i,
  })) as HTMLButtonElement;
  await waitFor(() => expect(trigger.disabled).toBe(false));
  fireEvent.click(trigger);
  return trigger;
}

describe("RepoMenu", () => {
  it("keeps Archive behind the overflow menu", async () => {
    renderMenu(false);
    // The action is not visible until the menu is opened.
    expect(screen.queryByRole("menuitem", { name: /archive/i })).toBeNull();
    await openMenu();
    expect(
      await screen.findByRole("menuitem", { name: "Archive" }),
    ).toBeTruthy();
  });

  it("confirms then PATCHes archived:true", async () => {
    renderMenu(false);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    // A confirm dialog gates the destructive-ish action.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      const call = rpcCall("repos/setArchived");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ archived: true });
    });
  });

  it("offers Unarchive for an archived repo", async () => {
    renderMenu(true);
    await openMenu();
    expect(
      await screen.findByRole("menuitem", { name: "Unarchive" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });

  it("keeps the dialog open and shows an error when the PATCH fails", async () => {
    renderMenu(false, true);
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", {
        name: "Archive",
      }),
    );

    // Error surfaced, dialog still open (the action did not silently succeed).
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
