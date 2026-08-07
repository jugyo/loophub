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
  let activeWorkspaces: Workspace[] = [
    {
      branch: "workspace/current",
      created_at: "2026-01-02T00:00:00Z",
      archived_at: null,
      branch_exists: true,
    },
    {
      branch: "workspace/missing",
      created_at: "2026-01-03T00:00:00Z",
      archived_at: null,
      branch_exists: false,
    },
  ];
  let archivedWorkspaces: Workspace[] = [
    {
      branch: "workspace/old",
      created_at: "2026-01-01T00:00:00Z",
      archived_at: "2026-06-02T00:00:00Z",
      branch_exists: true,
    },
  ];
  let extraPrompt: string | null = null;
  return mockRpcFetch({
    "repos/get": () => repo(initialArchived),
    "repos/mergeMode": () => mergeMode(null),
    "repos/agentConfig": () => agentConfig(),
    "repos/githubPrExportExtraPrompt": () => ({ extra_prompt: extraPrompt }),
    "repos/setGithubPrExportExtraPrompt": (p) => {
      if (patchFails) throw new RpcFault(500, "boom");
      const raw = p.extra_prompt;
      extraPrompt =
        typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      return { extra_prompt: extraPrompt };
    },
    "settings/get": () => ({ workflowContractLanguage: "en" }),
    "workflows/list": () => [
      {
        id: 44,
        name: "Repo loop",
        description: "Only for this repository",
        execute_prompt: "",
        verify_prompt: "",
        archived_at: null,
        created_at: "2026-08-03T00:00:00Z",
        updated_at: "2026-08-03T00:00:00Z",
        scope: {
          kind: "repository",
          repo: { id: 1, owner: "me", name: "proj" },
        },
      },
    ],
    "workflows/create": () => ({
      id: 45,
      name: "Build",
      description: "Build a feature",
      execute_prompt: "",
      verify_prompt: "",
      archived_at: null,
      created_at: "2026-08-03T00:00:00Z",
      updated_at: "2026-08-03T00:00:00Z",
      scope: {
        kind: "repository",
        repo: { id: 1, owner: "me", name: "proj" },
      },
    }),
    "terminal/launch": () => ({ ok: true }),
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
    "workspaces/listForSettings": () => activeWorkspaces,
    "workspaces/listArchivedForSettings": () => archivedWorkspaces,
    "workspaces/create": (p) => {
      if (patchFails) throw new RpcFault(422, "workspace create failed");
      const workspace: Workspace = {
        branch: p.branch,
        created_at: "2026-08-02T00:00:00Z",
        archived_at: null,
        branch_exists: true,
      };
      activeWorkspaces = [...activeWorkspaces, workspace];
      return workspace;
    },
    "workspaces/archive": (p) => {
      if (patchFails) throw new RpcFault(500, "workspace archive failed");
      const workspace = activeWorkspaces.find((w) => w.branch === p.branch)!;
      activeWorkspaces = activeWorkspaces.filter((w) => w.branch !== p.branch);
      const archived = {
        ...workspace,
        archived_at: "2026-08-02T00:00:00Z",
      };
      archivedWorkspaces = [...archivedWorkspaces, archived];
      return archived;
    },
    "workspaces/unarchive": (p) => {
      if (patchFails) throw new RpcFault(500, "workspace restore failed");
      const workspace = archivedWorkspaces.find((w) => w.branch === p.branch)!;
      archivedWorkspaces = archivedWorkspaces.filter(
        (w) => w.branch !== p.branch,
      );
      const active = { ...workspace, archived_at: null };
      activeWorkspaces = [...activeWorkspaces, active];
      return active;
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
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/settings/workflows",
    component: () => <SettingsRouteComponent section="workflows" />,
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
      workflowsRoute,
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
      screen.getByRole("link", { name: "Workflows" }).getAttribute("href"),
    ).toBe("/r/me/proj/settings/workflows");
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

  it("lists repository-scoped workflows in repository settings", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workflows");

    expect(
      await screen.findByRole("heading", { name: "Workflows" }),
    ).toBeTruthy();
    expect(screen.getByText("Repo loop")).toBeTruthy();
    expect(rpcCall("workflows/list")?.params).toMatchObject({
      repo: "me/proj",
    });

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    await waitFor(() =>
      expect(rpcCall("terminal/launch")?.params).toMatchObject({
        repo: "me/proj",
        workflow: "workflow-create",
      }),
    );
    expect(
      (rpcCall("terminal/launch")?.params as { prompt: string }).prompt,
    ).toContain("--repo me/proj");
  });

  it("creates a repository-scoped workflow from a template", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workflows");

    await screen.findByRole("heading", { name: "Workflows" });
    fireEvent.click(
      screen.getByRole("button", { name: "Create workflow from template" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Create workflow from template",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create Build workflow" }),
    );

    await waitFor(() =>
      expect(rpcCall("workflows/create")?.params).toMatchObject({
        name: "Build",
        repo: "me/proj",
      }),
    );
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

  it("lists archived workspaces in a dialog and unarchives one", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workspaces");

    const section = (
      await screen.findByRole("heading", { name: "Archived workspaces" })
    ).closest("section")!;
    expect(within(section).queryByText("workspace/old")).toBeNull();
    const trigger = within(section).getByRole("button", {
      name: "View archived workspaces (1)",
    });
    expect(trigger.className).toContain("text-muted-foreground");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", {
      name: "Archived workspaces",
    });
    expect(within(dialog).queryByText("Unarchive workspace/old?")).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: "Close archived workspaces",
      }),
    ).toBeTruthy();
    expect(within(dialog).getByText("workspace/old")).toBeTruthy();
    expect(within(dialog).getByText("Branch exists")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unarchive workspace/old" }),
    );

    await waitFor(() => {
      expect(rpcCall("workspaces/unarchive")?.params).toMatchObject({
        repo: "me/proj",
        branch: "workspace/old",
      });
    });
    await waitFor(() =>
      expect(within(dialog).queryByText("workspace/old")).toBeNull(),
    );
    expect(within(dialog).getByText("No archived workspaces.")).toBeTruthy();
  });

  it("lists active workspaces with branch status and archives one", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workspaces");

    const section = (
      await screen.findByRole("heading", { name: "Active workspaces" })
    ).closest("section")!;
    expect(within(section).getByText("workspace/current")).toBeTruthy();
    expect(within(section).getByText("workspace/missing")).toBeTruthy();
    expect(within(section).getByText("Branch exists")).toBeTruthy();
    expect(within(section).getByText("Branch missing")).toBeTruthy();

    fireEvent.click(
      within(section).getByRole("button", {
        name: "Archive workspace/current",
      }),
    );

    expect(rpcCall("workspaces/archive")).toBeUndefined();
    const dialog = await screen.findByRole("dialog", {
      name: "Archive workspace/current",
    });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    await waitFor(() =>
      expect(rpcCall("workspaces/archive")?.params).toMatchObject({
        repo: "me/proj",
        branch: "workspace/current",
      }),
    );
    await waitFor(() =>
      expect(within(section).queryByText("workspace/current")).toBeNull(),
    );
    const archivedSection = screen
      .getByRole("heading", { name: "Archived workspaces" })
      .closest("section")!;
    fireEvent.click(
      within(archivedSection).getByRole("button", {
        name: "View archived workspaces (2)",
      }),
    );
    expect(
      within(
        await screen.findByRole("dialog", { name: "Archived workspaces" }),
      ).getByText("workspace/current"),
    ).toBeTruthy();
  });

  it("creates a workspace with the existing branch-based procedure", async () => {
    renderSettings(false, false, "/r/me/proj/settings/workspaces");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    const dialog = await screen.findByRole("dialog", {
      name: "New workspace",
    });
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "workspace/new" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create workspace" }),
    );

    await waitFor(() =>
      expect(rpcCall("workspaces/create")?.params).toMatchObject({
        repo: "me/proj",
        branch: "workspace/new",
      }),
    );
    expect(await screen.findByText("workspace/new")).toBeTruthy();
  });

  it("shows workspace archive failures and keeps the active row", async () => {
    renderSettings(false, true, "/r/me/proj/settings/workspaces");

    const section = (
      await screen.findByRole("heading", { name: "Active workspaces" })
    ).closest("section")!;
    fireEvent.click(
      within(section).getByRole("button", {
        name: "Archive workspace/current",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Archive workspace/current",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    expect(
      await within(dialog).findByText(/workspace archive failed/),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(section).getByText("workspace/current")).toBeTruthy();
  });

  it("shows workspace unarchive failures", async () => {
    renderSettings(false, true, "/r/me/proj/settings/workspaces");

    const section = (
      await screen.findByRole("heading", { name: "Archived workspaces" })
    ).closest("section")!;
    fireEvent.click(
      within(section).getByRole("button", {
        name: "View archived workspaces (1)",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Archived workspaces",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unarchive workspace/old" }),
    );

    expect(
      await within(dialog).findByText(/workspace restore failed/),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(dialog).getByText("workspace/old")).toBeTruthy();
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

  it("saves and previews the Create PR on GitHub additional prompt (#2422)", async () => {
    renderSettings(false, false, "/r/me/proj/settings/pull-requests");
    const textarea = (await screen.findByLabelText(
      "Additional Create PR on GitHub prompt",
    )) as HTMLTextAreaElement;
    // Preview is behind a link (same pattern as Workflows' System prompt), not inline.
    expect(
      screen.queryByRole("dialog", {
        name: "Create PR on GitHub prompt preview",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Preview prompt$/i }));
    const dialog = await screen.findByRole("dialog", {
      name: "Create PR on GitHub prompt preview",
    });
    // Default preview is the template only (sample PR #1).
    expect(dialog.textContent).toContain(
      "lh pr create-github-pr 1 --repo me/proj",
    );
    expect(dialog.textContent).not.toContain("Prefer type/short-slug");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close prompt preview" }),
    );
    expect(
      screen.queryByRole("dialog", {
        name: "Create PR on GitHub prompt preview",
      }),
    ).toBeNull();

    fireEvent.change(textarea, {
      target: { value: "Prefer type/short-slug branch names." },
    });
    // Draft is reflected when the preview is reopened before save.
    fireEvent.click(screen.getByRole("button", { name: /^Preview prompt$/i }));
    expect(
      (
        await screen.findByRole("dialog", {
          name: "Create PR on GitHub prompt preview",
        })
      ).textContent,
    ).toContain("Prefer type/short-slug branch names.");
    fireEvent.click(
      screen.getByRole("button", { name: "Close prompt preview" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => {
      expect(
        rpcCall("repos/setGithubPrExportExtraPrompt")?.params,
      ).toMatchObject({
        name: "me/proj",
        extra_prompt: "Prefer type/short-slug branch names.",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /^Clear$/i }));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[1]?.body ?? "{}"));
          } catch {
            return null;
          }
        })
        .filter((c) => c?.method === "repos/setGithubPrExportExtraPrompt");
      expect(calls.at(-1)?.params).toMatchObject({
        name: "me/proj",
        extra_prompt: null,
      });
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
