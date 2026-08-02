import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
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
import type {
  Repo,
  RepoAgentConfig,
  RepoMergeMode,
  Workspace,
} from "@/api/types";
import {
  RepoSettingsPage,
  type RepoSettingsSection,
} from "./repo-settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function repo(archived: boolean): Repo {
  return {
    id: 1,
    name: "proj",
    full_name: "me/proj",
    owner: { login: "me" },
    default_branch: "main",
    local_path: "/tmp/proj",
    archived,
    archived_at: archived ? "2026-06-01T00:00:00Z" : null,
    favorite: false,
    favorited_at: null,
    created_at: "2026-01-01T00:00:00Z",
    merge_mode: null,
    herdr_session_name: "repo-abcd1234",
  };
}

function mergeMode(setting: RepoMergeMode["setting"]): RepoMergeMode {
  return {
    setting,
    effective: setting ?? "merge",
    has_github_remote: true,
  };
}

function agentConfig(override = false): RepoAgentConfig {
  return {
    setting: {
      override,
      runtime: override ? "codex" : null,
      model: override ? "gpt-5.6-sol" : null,
      effort: override ? "high" : null,
    },
    effective: {
      runtime: override ? "codex" : "claude-code",
      model: override ? "gpt-5.6-sol" : "opus",
      effort: override ? "high" : "medium",
    },
  };
}

function mockFetch(initialArchived: boolean, patchFails = false) {
  let archivedWorkspaces: Workspace[] = [
    {
      branch: "workspace/old",
      created_at: "2026-01-01T00:00:00Z",
      archived_at: "2026-06-02T00:00:00Z",
      branch_exists: true,
    },
  ];
  return mockRpcFetch({
    "repos/get": () => repo(initialArchived),
    "repos/mergeMode": () => mergeMode(null),
    "repos/agentConfig": () => agentConfig(),
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
    "repos/setAgentConfig": (p) => {
      if (patchFails) throw new RpcFault(500, "boom");
      return agentConfig(p.override);
    },
    "repos/update": (p) => {
      if (patchFails) throw new RpcFault(422, "branch not found: nope");
      return { ...repo(initialArchived), default_branch: p.default_branch };
    },
    "workspaces/listArchived": () => archivedWorkspaces,
    "workspaces/unarchive": (p) => {
      if (patchFails) throw new RpcFault(500, "workspace restore failed");
      const workspace = archivedWorkspaces.find((w) => w.branch === p.branch)!;
      archivedWorkspaces = archivedWorkspaces.filter(
        (w) => w.branch !== p.branch,
      );
      return { ...workspace, archived_at: null };
    },
  });
}

function renderSettings(
  initialArchived = false,
  patchFails = false,
  initialEntry = "/r/me/proj/settings",
) {
  vi.stubGlobal("fetch", mockFetch(initialArchived, patchFails));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings",
    component: () => <SettingsRouteComponent section="general" />,
  });
  const pullRequestsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings/pull-requests",
    component: () => <SettingsRouteComponent section="pull-requests" />,
  });
  const codingAgentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings/coding-agent",
    component: () => <SettingsRouteComponent section="coding-agent" />,
  });
  const workspacesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings/workspaces",
    component: () => <SettingsRouteComponent section="workspaces" />,
  });
  const archiveRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings/archive",
    component: () => <SettingsRouteComponent section="archive" />,
  });
  function SettingsRouteComponent({
    section,
  }: {
    section: RepoSettingsSection;
  }) {
    const { owner, repo } = useParams({ strict: false }) as {
      owner: string;
      repo: string;
    };
    return <RepoSettingsPage owner={owner} repo={repo} section={section} />;
  }
  // Rename navigates to the renamed repo's settings URL (still `settingsRoute`,
  // just with new params); unarchive-on-archive navigates home.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="home-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      settingsRoute,
      pullRequestsRoute,
      codingAgentRoute,
      workspacesRoute,
      archiveRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...rendered, router };
}

describe("RepoSettingsPage", () => {
  it("navigates between settings sections and keeps the selection in the URL", async () => {
    const { router } = renderSettings();

    expect(
      await screen.findByRole("heading", { name: "General" }),
    ).toBeTruthy();
    const general = screen.getByRole("link", { name: "General" });
    expect(general.getAttribute("aria-current")).toBe("page");
    expect(general.getAttribute("href")).toBe("/r/me/proj/settings");
    expect(
      screen.getByRole("link", { name: "Coding agent" }).getAttribute("href"),
    ).toBe("/r/me/proj/settings/coding-agent");
    expect(
      screen.getByRole("link", { name: "Workspaces" }).getAttribute("href"),
    ).toBe("/r/me/proj/settings/workspaces");
    expect(
      screen.getByRole("link", { name: "Archive" }).getAttribute("href"),
    ).toBe("/r/me/proj/settings/archive");

    const pullRequests = screen.getByRole("link", { name: "Pull requests" });
    expect(pullRequests.getAttribute("href")).toBe(
      "/r/me/proj/settings/pull-requests",
    );
    pullRequests.focus();
    expect(document.activeElement).toBe(pullRequests);
    fireEvent.click(pullRequests);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/r/me/proj/settings/pull-requests",
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "PR action" }),
    ).toBeTruthy();
    expect(pullRequests.getAttribute("aria-current")).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "General" })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Rename" })).toBeNull();
  });

  it("restores a directly addressed settings section", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workspaces");

    expect(
      await screen.findByRole("heading", { name: "Archived workspaces" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Workspaces" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("does not render a duplicate content heading or repo back link", async () => {
    renderSettings(false);

    expect(await screen.findByRole("heading", { name: "Rename" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "me/proj settings" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /me\/proj/ })).toBeNull();
  });

  it("renames via the form and navigates to the renamed repo (#485)", async () => {
    const { router } = renderSettings(false);
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
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/r/acme/other/settings"),
    );
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
    renderSettings(false, false, "/r/me/proj/settings/archive");
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
    renderSettings(true, false, "/r/me/proj/settings/archive");
    expect(
      await screen.findByRole("button", { name: "Unarchive" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("keeps the dialog open and shows an error when the archive PATCH fails", async () => {
    renderSettings(false, true, "/r/me/proj/settings/archive");
    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Archive",
      }),
    );

    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the current base branch and saves via repos/update (#1115)", async () => {
    renderSettings(false);
    const input = (await screen.findByRole("textbox", {
      name: /base branch/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("main"));

    const submit = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    // Unchanged value: save is disabled.
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "develop" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => {
      const call = rpcCall("repos/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({
        name: "me/proj",
        default_branch: "develop",
      });
    });
  });

  it("disables save for a blank base branch (#1115)", async () => {
    renderSettings(false);
    const input = (await screen.findByRole("textbox", {
      name: /base branch/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("main"));

    fireEvent.change(input, { target: { value: "   " } });
    const submit = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(true));
  });

  it("surfaces the 422 branch-not-found error (#1115)", async () => {
    renderSettings(false, true);
    const input = (await screen.findByRole("textbox", {
      name: /base branch/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("main"));

    fireEvent.change(input, { target: { value: "nope" } });
    const submit = (await screen.findByRole("button", {
      name: "Save",
    })) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);

    expect(await screen.findByText(/branch not found/)).toBeTruthy();
  });

  it("lists archived workspaces and unarchives one", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workspaces");

    const section = (
      await screen.findByRole("heading", { name: "Archived workspaces" })
    ).closest("section")!;
    expect(within(section).getByText("workspace/old")).toBeTruthy();
    fireEvent.click(
      within(section).getByRole("button", {
        name: "Unarchive workspace/old",
      }),
    );

    await waitFor(() => {
      expect(rpcCall("workspaces/unarchive")?.params).toMatchObject({
        repo: "me/proj",
        branch: "workspace/old",
      });
    });
    await waitFor(() =>
      expect(within(section).queryByText("workspace/old")).toBeNull(),
    );
  });

  it("shows workspace unarchive failures", async () => {
    renderSettings(false, true, "/r/me/proj/settings/workspaces");

    const section = (
      await screen.findByRole("heading", { name: "Archived workspaces" })
    ).closest("section")!;
    fireEvent.click(
      within(section).getByRole("button", {
        name: "Unarchive workspace/old",
      }),
    );

    expect(
      await within(section).findByText(/workspace restore failed/),
    ).toBeTruthy();
    expect(within(section).getByText("workspace/old")).toBeTruthy();
  });

  it("switches the PR action and persists via repos/setMergeMode", async () => {
    renderSettings(false, false, "/r/me/proj/settings/pull-requests");
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

  it("keeps the Coding agent override accessible and persists changes", async () => {
    renderSettings(false, false, "/r/me/proj/settings/coding-agent");
    const group = await screen.findByRole("radiogroup", {
      name: /override application coding agent settings/i,
    });
    const override = within(group).getByRole("radio", {
      name: /on \(override for this repo\)/i,
    });
    fireEvent.click(override);

    await waitFor(() => {
      expect(rpcCall("repos/setAgentConfig")?.params).toMatchObject({
        name: "me/proj",
        override: true,
        runtime: "claude-code",
        model: "",
        effort: "",
      });
    });
  });
});
