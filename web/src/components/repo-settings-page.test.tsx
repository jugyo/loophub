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
import type { Repo, RepoMergeMode } from "@/api/types";
import { RepoSettingsPage } from "./repo-settings-page";

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
    favorite: false,
    favorited_at: null,
    created_at: "2026-01-01T00:00:00Z",
    merge_mode: null,
  };
}

function mergeMode(setting: RepoMergeMode["setting"]): RepoMergeMode {
  return {
    setting,
    effective: setting ?? "merge",
    has_github_remote: true,
  };
}

function mockFetch(initialArchived: boolean, patchFails = false) {
  return mockRpcFetch({
    "repos/get": () => repo(initialArchived),
    "repos/mergeMode": () => mergeMode(null),
    "repos/setArchived": (p) => {
      if (patchFails) throw new RpcFault(500, "boom");
      return repo(p.archived);
    },
    "repos/rename": (p) => {
      if (patchFails) throw new RpcFault(422, "already registered");
      return { ...repo(initialArchived), full_name: p.new_name };
    },
    "repos/setMergeMode": (p) => {
      if (patchFails) throw new RpcFault(500, "boom");
      return { ...repo(initialArchived), merge_mode: p.mode };
    },
  });
}

function renderSettings(initialArchived = false, patchFails = false) {
  vi.stubGlobal("fetch", mockFetch(initialArchived, patchFails));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings",
    component: SettingsRouteComponent,
  });
  function SettingsRouteComponent() {
    const { owner, repo } = settingsRoute.useParams();
    return <RepoSettingsPage owner={owner} repo={repo} />;
  }
  // Rename navigates to the renamed repo's settings URL (still `settingsRoute`,
  // just with new params); unarchive-on-archive navigates home.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="home-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/r/me/proj/settings"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("RepoSettingsPage", () => {
  it("renames via the form and navigates to the renamed repo (#485)", async () => {
    renderSettings(false);
    const input = (await screen.findByRole("textbox", {
      name: /new repository name/i,
    })) as HTMLInputElement;
    expect(input.value).toBe("me/proj");

    const submit = screen.getByRole("button", {
      name: "Rename",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "acme/other" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => {
      const call = rpcCall("repos/rename");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({
        name: "me/proj",
        new_name: "acme/other",
      });
    });
    expect(
      await screen.findByRole("heading", { name: "acme/other settings" }),
    ).toBeTruthy();
  });

  it("shows the server error and keeps the form when rename fails (#485)", async () => {
    renderSettings(false, true);
    const input = await screen.findByRole("textbox", {
      name: /new repository name/i,
    });
    fireEvent.change(input, { target: { value: "me/taken" } });
    const submit = (await screen.findByRole("button", {
      name: "Rename",
    })) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText(/already registered/)).toBeTruthy();
  });

  it("confirms then PATCHes archived:true", async () => {
    renderSettings(false);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      const call = rpcCall("repos/setArchived");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ archived: true });
    });
    expect(await screen.findByTestId("home-page")).toBeTruthy();
  });

  it("offers Unarchive for an archived repo", async () => {
    renderSettings(true);
    expect(
      await screen.findByRole("button", { name: "Unarchive" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("keeps the dialog open and shows an error when the archive PATCH fails", async () => {
    renderSettings(false, true);
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Archive",
      }),
    );

    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("switches the PR action and persists via repos/setMergeMode", async () => {
    renderSettings(false);
    const group = await screen.findByRole("radiogroup", {
      name: /pr action/i,
    });
    const githubOption = within(group).getByRole("radio", {
      name: /create pr on github/i,
    }) as HTMLButtonElement;
    await waitFor(() => expect(githubOption.disabled).toBe(false));
    fireEvent.click(githubOption);

    await waitFor(() => {
      const call = rpcCall("repos/setMergeMode");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ mode: "github_pr" });
    });
  });
});
