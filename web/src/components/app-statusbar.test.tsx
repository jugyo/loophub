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
import { SettingsPage } from "@/components/settings-page";
import { AppStatusbar } from "./app-statusbar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function costSummaryHandlers(
  tokenRateHistory?: number[],
  tokensPerSecond?: number | null,
) {
  return {
    "sessions/costSummary": () => [
      {
        agent: "claude-code",
        month: 1,
        week: 1,
        day: 1,
        ...(tokenRateHistory
          ? { tokens_per_5m_history: tokenRateHistory }
          : {}),
        ...(tokensPerSecond !== undefined
          ? { tokens_per_second: tokensPerSecond }
          : {}),
      },
    ],
  };
}

function renderSettingsShell(
  initial: GlobalSettings,
  tokenRateHistory?: number[],
  tokensPerSecond?: number | null,
) {
  let settings = structuredClone(initial);
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => settings,
      ...costSummaryHandlers(tokenRateHistory, tokensPerSecond),
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
      ...costSummaryHandlers(),
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
      autoModeOnLaunch: false,
      model: "opus",
      effort: "high",
    },
    codex: {
      autoModeOnLaunch: false,
      model: "gpt-5.6-sol",
      effort: "medium",
    },
  },
  codingAgent: "claude-code",
  devCostLimitUsd: 12.5,
};

describe("AppStatusbar", () => {
  it("shows TPS first and keeps the selected agent settings in order in a right-aligned group", async () => {
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
    ).toEqual(["TPS", "Agent", "Model", "Effort", "Cost limit / session"]);

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

  it("shows unavailable TPS without an Activity icon", async () => {
    renderSettingsShell(DEFAULT_SETTINGS);

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    expect(
      within(statusbar).getByLabelText("TPS: n/a tokens per second"),
    ).toBeTruthy();
    expect(statusbar.querySelector(".lucide-activity")).toBeNull();
    expect(
      within(statusbar).queryByRole("img", {
        name: /token throughput buckets/,
      }),
    ).toBeNull();
  });

  it("shows unavailable TPS when the current sample is missing without discarding history", async () => {
    const history = Array(24).fill(0);
    history[23] = 1_200_000;
    renderSettingsShell(DEFAULT_SETTINGS, history, null);

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    expect(
      within(statusbar).getByLabelText("TPS: n/a tokens per second"),
    ).toBeTruthy();
    const chart = within(statusbar).getByRole("img", {
      name: "24 token throughput buckets, oldest to newest",
    });
    const bars = chart.querySelectorAll<HTMLElement>("[data-token-count]");
    expect(bars).toHaveLength(24);
    expect(bars[23].dataset.tokenCount).toBe("1200000");
    expect(bars[23].style.height).toBe("100%");
  });

  it("shows short TPS without an average qualifier and keeps history buckets in order", async () => {
    const history = Array(24).fill(0);
    history[1] = 600_000;
    history[22] = 300_000;
    history[23] = 1_200_000;
    renderSettingsShell(DEFAULT_SETTINGS, history, 4_000);

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    const rate = await within(statusbar).findByLabelText(
      "TPS: 4k tokens per second",
    );
    expect(rate.textContent).toContain("4k");
    expect(statusbar.textContent).not.toContain("Token rate");
    expect(statusbar.textContent).not.toContain("avg / 5m");

    const chart = within(statusbar).getByRole("img", {
      name: "24 token throughput buckets, oldest to newest",
    });
    const bars = chart.querySelectorAll<HTMLElement>("[data-token-count]");
    expect(bars).toHaveLength(24);
    expect(bars[0].dataset.tokenCount).toBe("0");
    expect(bars[0].style.height).toBe("0%");
    expect(bars[1].dataset.tokenCount).toBe("600000");
    expect(bars[1].style.height).toBe("50%");
    expect(bars[22].dataset.tokenCount).toBe("300000");
    expect(bars[22].style.height).toBe("25%");
    expect(bars[23].dataset.tokenCount).toBe("1200000");
    expect(bars[23].style.height).toBe("100%");
  });

  it("distinguishes measured zero TPS from unavailable current samples", async () => {
    renderSettingsShell(DEFAULT_SETTINGS, Array(24).fill(0), 0);

    const statusbar = await screen.findByRole("contentinfo", {
      name: "Application status",
    });
    expect(
      within(statusbar).getByLabelText("TPS: 0 tokens per second"),
    ).toBeTruthy();
    expect(
      within(statusbar).getByRole("img", {
        name: "24 token throughput buckets, oldest to newest",
      }),
    ).toBeTruthy();
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
    // Cost limit / TPS stay instance-wide even when the agent triple is repo-scoped.
    expect(statusValue(statusbar, "Cost limit / session")).toBe("$12.50");
    expect(
      within(statusbar).getByLabelText("TPS: n/a tokens per second"),
    ).toBeTruthy();
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
