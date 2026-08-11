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
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { CodingAgent, GlobalSettings, RepoAgentConfig } from "@/api/types";
import {
  DebugLogPanel,
  DebugPanelProvider,
  DebugPanelToggle,
} from "@/components/debug-panel";
import { SettingsPage } from "@/components/settings-page";
import { WebConfigProvider } from "@/lib/web-config";
import { AppStatusbar } from "./app-statusbar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSettingsShell(initial: GlobalSettings) {
  let settings = structuredClone(initial);
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => settings,
      "settings/update": (params) => {
        const agent = params.agent as CodingAgent | undefined;
        settings = {
          ...settings,
          ...(params.codingAgent
            ? { codingAgent: params.codingAgent as CodingAgent }
            : {}),
          ...(params.devCostLimitUsd !== undefined
            ? { devCostLimitUsd: params.devCostLimitUsd as number }
            : {}),
          agents: agent
            ? {
                ...settings.agents,
                [agent]: {
                  ...settings.agents[agent],
                  ...(params.model !== undefined
                    ? { model: params.model as string }
                    : {}),
                  ...(params.effort !== undefined
                    ? { effort: params.effort as string }
                    : {}),
                },
              }
            : settings.agents,
        };
        return settings;
      },
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <AppStatusbar />
      </>
    ),
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsPage,
  });
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/workflows",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, workflowsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function renderRepoShell(
  initial: GlobalSettings,
  agentConfig: RepoAgentConfig,
  initialPath = "/r/me/proj",
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => structuredClone(initial),
      "repos/agentConfig": () => agentConfig,
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <AppStatusbar />
      </>
    ),
  });
  const repoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo",
    component: () => null,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, repoRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function statusValue(
  statusbar: HTMLElement,
  label: string,
): string | null | undefined {
  const term = within(statusbar).getByText(label);
  return term.nextElementSibling?.textContent;
}

const DEFAULT_SETTINGS: GlobalSettings = {
  agents: {
    "claude-code": {
      model: "opus",
      effort: "high",
    },
    codex: {
      model: "gpt-5.6-sol",
      effort: "medium",
    },
  },
  codingAgent: "claude-code",
  devCostLimitUsd: 12.5,
};

describe("AppStatusbar", () => {
  it("keeps the selected agent settings in order in a right-aligned group", async () => {
    renderSettingsShell(DEFAULT_SETTINGS);

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    const group = statusbar.querySelector("dl");
    expect(group?.className).toContain("ml-auto");
    expect(group?.className).toContain("justify-end");
    expect(group?.className).toContain("text-right");
    expect(
      Array.from(
        group?.children ?? [],
        (item) => item.querySelector("dt")?.textContent,
      ),
    ).toEqual(["Agent", "Model", "Effort", "Cost limit / session"]);

    for (const [label, value] of [
      ["Agent", "Claude Code"],
      ["Model", "opus"],
      ["Effort", "high"],
      ["Cost limit / session", "$12.50"],
    ]) {
      const term = within(statusbar).getByText(label);
      expect(term.tagName).toBe("DT");
      expect(term.nextElementSibling?.tagName).toBe("DD");
      expect(term.nextElementSibling?.textContent).toBe(value);
    }
  });

  it("shows explicit text when the selected agent model or effort is not set", async () => {
    renderSettingsShell({
      ...DEFAULT_SETTINGS,
      agents: {
        ...DEFAULT_SETTINGS.agents,
        "claude-code": {
          ...DEFAULT_SETTINGS.agents["claude-code"],
          model: "",
          effort: "   ",
        },
      },
    });

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    expect(within(statusbar).getAllByText("Not set")).toHaveLength(2);
  });

  it("refreshes the selected agent values after they are changed on Settings", async () => {
    renderSettingsShell(DEFAULT_SETTINGS);
    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    await waitFor(() =>
      expect(within(statusbar).getByText("Claude Code")).toBeTruthy(),
    );

    const codingAgentGroup = screen.getByRole("radiogroup", {
      name: /^coding agent$/i,
    });
    const codexOption = within(codingAgentGroup).getByRole("radio", {
      name: "Codex",
    });
    await waitFor(() =>
      expect((codexOption as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(codexOption);

    await waitFor(() => {
      expect(within(statusbar).getByText("Codex")).toBeTruthy();
      expect(within(statusbar).getByText("gpt-5.6-sol")).toBeTruthy();
      expect(within(statusbar).getByText("medium")).toBeTruthy();
    });

    const costInput = screen.getByLabelText(
      "Task over-budget limit in USD",
    ) as HTMLInputElement;
    fireEvent.change(costInput, { target: { value: "7.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(within(statusbar).getByText("$7.25")).toBeTruthy(),
    );
  });

  it("shows the repo Coding agent override on a repo-scoped page (#1536)", async () => {
    renderRepoShell(DEFAULT_SETTINGS, {
      setting: {
        override: true,
        runtime: "codex",
        model: "gpt-5.4",
        effort: "xhigh",
      },
      effective: {
        runtime: "codex",
        model: "gpt-5.4",
        effort: "xhigh",
      },
    });

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    await waitFor(() => {
      expect(statusValue(statusbar, "Agent")).toBe("Codex");
      expect(statusValue(statusbar, "Model")).toBe("gpt-5.4");
      expect(statusValue(statusbar, "Effort")).toBe("xhigh");
    });
    // Cost limit stays instance-wide even when the agent triple is repo-scoped.
    expect(statusValue(statusbar, "Cost limit / session")).toBe("$12.50");
    expect(rpcCall("repos/agentConfig")?.params).toEqual({ name: "me/proj" });
  });

  it("falls back to application defaults when the repo has no Coding agent override (#1536)", async () => {
    renderRepoShell(DEFAULT_SETTINGS, {
      setting: {
        override: false,
        runtime: null,
        model: null,
        effort: null,
      },
      // API already resolves effective from application settings while override is off.
      effective: {
        runtime: "claude-code",
        model: "opus",
        effort: "high",
      },
    });

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    await waitFor(() => {
      expect(statusValue(statusbar, "Agent")).toBe("Claude Code");
      expect(statusValue(statusbar, "Model")).toBe("opus");
      expect(statusValue(statusbar, "Effort")).toBe("high");
    });
    expect(statusValue(statusbar, "Cost limit / session")).toBe("$12.50");
  });

  it("hosts the debug panel toggle inside the status bar when --debug is on", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "settings/get": () => structuredClone(DEFAULT_SETTINGS),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rootRoute = createRootRoute({
      component: () => (
        <DebugPanelProvider>
          <DebugLogPanel />
          <AppStatusbar debugPanel={<DebugPanelToggle />} />
        </DebugPanelProvider>
      ),
    });
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([homeRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <WebConfigProvider config={{ debug: true }}>
          <RouterProvider router={router} />
        </WebConfigProvider>
      </QueryClientProvider>,
    );

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    const toggle = within(statusbar).getByRole("button", {
      name: "Debug panel",
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByTestId("debug-log-panel")).toBeTruthy();
  });

  it("keeps application Coding agent settings on pages that are not repo-scoped (#1536)", async () => {
    renderRepoShell(
      DEFAULT_SETTINGS,
      {
        setting: {
          override: true,
          runtime: "codex",
          model: "gpt-5.4",
          effort: "xhigh",
        },
        effective: {
          runtime: "codex",
          model: "gpt-5.4",
          effort: "xhigh",
        },
      },
      "/",
    );

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    await waitFor(() => {
      expect(statusValue(statusbar, "Agent")).toBe("Claude Code");
      expect(statusValue(statusbar, "Model")).toBe("opus");
      expect(statusValue(statusbar, "Effort")).toBe("high");
    });
    expect(statusValue(statusbar, "Cost limit / session")).toBe("$12.50");
    expect(rpcCall("repos/agentConfig")).toBeUndefined();
  });
});
