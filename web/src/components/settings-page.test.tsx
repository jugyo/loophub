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
import type { CodingAgent } from "@/api/types";
import { SettingsPage } from "./settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type AgentSettingsForTest = {
  model: string;
  effort: string;
};

const DEFAULT_AGENT_SETTINGS: Record<CodingAgent, AgentSettingsForTest> = {
  "claude-code": { model: "opus", effort: "medium" },
  codex: { model: "gpt-5.5", effort: "medium" },
  grok: {
    model: "grok-code-fast-1",
    effort: "medium",
  },
};

function mockFetch(
  initialAgents: Partial<Record<CodingAgent, AgentSettingsForTest>> = {},
  initialCodingAgent: CodingAgent = "claude-code",
  initialDevCostLimitUsd = 10,
  initialWorkflowContractLanguage: "en" | "ja" = "en",
) {
  const agents: Record<CodingAgent, AgentSettingsForTest> = {
    ...DEFAULT_AGENT_SETTINGS,
    ...initialAgents,
  };
  let codingAgent = initialCodingAgent;
  let devCostLimitUsd = initialDevCostLimitUsd;
  let workflowContractLanguage = initialWorkflowContractLanguage;
  return mockRpcFetch({
    "settings/get": () => ({
      agents,
      codingAgent,
      devCostLimitUsd,
      workflowContractLanguage,
    }),
    "settings/update": (p) => {
      if (p.agent && p.model !== undefined) {
        agents[p.agent as CodingAgent] = {
          ...agents[p.agent as CodingAgent],
          model: p.model as string,
        };
      }
      if (p.agent && p.effort !== undefined) {
        agents[p.agent as CodingAgent] = {
          ...agents[p.agent as CodingAgent],
          effort: p.effort as string,
        };
      }
      if (p.codingAgent) codingAgent = p.codingAgent;
      if (p.devCostLimitUsd !== undefined) {
        devCostLimitUsd = p.devCostLimitUsd as number;
      }
      if (p.workflowContractLanguage) {
        workflowContractLanguage = p.workflowContractLanguage as "en" | "ja";
      }
      return { agents, codingAgent, devCostLimitUsd, workflowContractLanguage };
    },
  });
}

function renderSettings(
  initialAgents?: Partial<Record<CodingAgent, AgentSettingsForTest>>,
  initialCodingAgent: CodingAgent = "claude-code",
  initialDevCostLimitUsd = 10,
  initialWorkflowContractLanguage: "en" | "ja" = "en",
) {
  vi.stubGlobal(
    "fetch",
    mockFetch(
      initialAgents,
      initialCodingAgent,
      initialDevCostLimitUsd,
      initialWorkflowContractLanguage,
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <SettingsPage />,
  });
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/workflows",
    component: () => <div data-testid="workflows-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, workflowsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

async function modelDropdown(label: string): Promise<HTMLButtonElement> {
  return (await screen.findByLabelText(
    `Default model and effort (${label})`,
  )) as HTMLButtonElement;
}

async function openModelDropdown(label: string): Promise<HTMLElement> {
  fireEvent.pointerDown(await modelDropdown(label), {
    button: 0,
    ctrlKey: false,
  });
  return screen.findByRole("menu");
}

describe("SettingsPage", () => {
  it("shows the settings sidebar with Agent selected initially", async () => {
    renderSettings();

    const navigation = await screen.findByRole("navigation", {
      name: "Settings",
    });
    const agentLink = within(navigation).getByRole("link", { name: "Agent" });
    const workflowsLink = within(navigation).getByRole("link", {
      name: "Workflows",
    });

    expect(agentLink.getAttribute("href")).toBe("/settings");
    expect(agentLink.getAttribute("aria-current")).toBe("page");
    expect(workflowsLink.getAttribute("href")).toBe("/settings/workflows");
    expect(workflowsLink.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();

    const agentPanel = screen.getByRole("region", { name: "Agent" });
    expect(screen.queryByRole("main")).toBeNull();
    expect(
      within(agentPanel).getByRole("heading", { name: "Coding agent" }),
    ).toBeTruthy();
    expect(
      within(agentPanel).getByRole("heading", {
        name: "Task over-budget limit",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Manage workflows" })).toBeNull();
  });

  it("opens Workflows settings from the sidebar", async () => {
    const { router } = renderSettings();

    fireEvent.click(await screen.findByRole("link", { name: "Workflows" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/workflows"),
    );
    expect(await screen.findByTestId("workflows-page")).toBeTruthy();
  });

  it("shows the current coding agent as checked", async () => {
    renderSettings(undefined, "codex");
    const group = await screen.findByRole("radiogroup", {
      name: /^coding agent$/i,
    });
    const [claudeCodeOption, codexOption] = within(group).getAllByRole("radio");
    await waitFor(() =>
      expect(codexOption.getAttribute("aria-checked")).toBe("true"),
    );
    expect(claudeCodeOption.getAttribute("aria-checked")).toBe("false");
  });

  it("switches the coding agent and persists via settings/update", async () => {
    renderSettings(undefined, "claude-code");
    const group = await screen.findByRole("radiogroup", {
      name: /^coding agent$/i,
    });
    const [, codexOption] = within(group).getAllByRole(
      "radio",
    ) as HTMLButtonElement[];
    await waitFor(() => expect(codexOption.disabled).toBe(false));
    fireEvent.click(codexOption);

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ codingAgent: "codex" });
    });
    await waitFor(() =>
      expect(codexOption.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("shows the current default model+effort per agent in the dropdown trigger (#594, #682)", async () => {
    renderSettings({
      "claude-code": { model: "opus", effort: "high" },
      codex: { model: "gpt-5.5", effort: "low" },
    });
    const claudeDropdown = await modelDropdown("Claude Code");
    await waitFor(() =>
      expect(claudeDropdown.textContent).toContain("opus — high"),
    );

    const codexDropdown = await modelDropdown("Codex");
    expect(codexDropdown.textContent).toContain("gpt-5.5 — low");
  });

  it("offers every model x effort combination as shadcn dropdown items, per agent (#610, #682)", async () => {
    renderSettings();
    const claudeDropdown = await modelDropdown("Claude Code");
    await waitFor(() =>
      expect(claudeDropdown.textContent).toContain("opus — medium"),
    );
    let menu = await openModelDropdown("Claude Code");
    const claudeOptions = within(menu)
      .getAllByRole("menuitem")
      .map((o) => o.textContent);
    expect(claudeOptions).toEqual(
      expect.arrayContaining([
        "opus — low",
        "opus — medium",
        "opus — high",
        "opus — xhigh",
        "opus — max",
        "sonnet — high",
        "haiku — max",
      ]),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    menu = await openModelDropdown("Codex");
    const codexOptions = within(menu)
      .getAllByRole("menuitem")
      .map((o) => o.textContent);
    expect([
      ...new Set(codexOptions.map((option) => option?.split(" — ")[0])),
    ]).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(codexOptions).toEqual(
      expect.arrayContaining([
        "gpt-5.6-sol — minimal",
        "gpt-5.6-sol — low",
        "gpt-5.6-sol — medium",
        "gpt-5.6-sol — high",
        "gpt-5.5 — minimal",
        "gpt-5.5 — low",
        "gpt-5.5 — medium",
        "gpt-5.5 — high",
      ]),
    );
    // codex has no effort concept beyond these four static levels — no claude-code-only level
    // ("xhigh"/"max") should leak into its options.
    expect(codexOptions).not.toEqual(
      expect.arrayContaining(["gpt-5.5 — xhigh"]),
    );
  });

  it("selecting a combination saves model and effort together via settings/update, leaving the other agent untouched (#682)", async () => {
    renderSettings();
    const claudeDropdown = await modelDropdown("Claude Code");
    await waitFor(() =>
      expect(claudeDropdown.textContent).toContain("opus — medium"),
    );

    const menu = await openModelDropdown("Claude Code");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "claude-opus-4-8 — xhigh" }),
    );

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({
        agent: "claude-code",
        model: "claude-opus-4-8",
        effort: "xhigh",
      });
    });
    await waitFor(() =>
      expect(claudeDropdown.textContent).toContain("claude-opus-4-8 — xhigh"),
    );

    const codexDropdown = await modelDropdown("Codex");
    expect(codexDropdown.textContent).toContain("gpt-5.5 — medium");
  });

  it("shows a saved model+effort pair outside the suggestion list as its own selected option, instead of silently jumping to a different combination (#682)", async () => {
    renderSettings({
      "claude-code": {
        model: "claude-fable-5",
        effort: "medium",
      },
      codex: { model: "gpt-5.5", effort: "medium" },
    });
    const claudeDropdown = await modelDropdown("Claude Code");
    await waitFor(() =>
      expect(claudeDropdown.textContent).toContain("claude-fable-5 — medium"),
    );
    const menu = await openModelDropdown("Claude Code");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((o) => o.textContent),
    ).toContain("claude-fable-5 — medium");
  });

  it("preserves saved model names containing the value separator without re-saving the selected item", async () => {
    renderSettings({
      "claude-code": {
        model: "vendor::claude-fable-5",
        effort: "medium",
      },
      codex: { model: "gpt-5.5", effort: "medium" },
    });
    const claudeDropdown = await modelDropdown("Claude Code");
    await waitFor(() =>
      expect(claudeDropdown.textContent).toContain(
        "vendor::claude-fable-5 — medium",
      ),
    );

    const menu = await openModelDropdown("Claude Code");
    fireEvent.click(
      within(menu).getByRole("menuitem", {
        name: "vendor::claude-fable-5 — medium",
      }),
    );

    expect(rpcCall("settings/update")).toBeUndefined();
  });

  it("shows and saves the task over-budget limit as a USD amount", async () => {
    renderSettings(undefined, "claude-code", 12.5);
    const input = (await screen.findByLabelText(
      "Task over-budget limit in USD",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("12.50"));

    fireEvent.change(input, { target: { value: "7.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ devCostLimitUsd: 7.25 });
    });
    await waitFor(() => expect(input.value).toBe("7.25"));
  });

  it("validates the task over-budget limit before saving", async () => {
    renderSettings();
    const input = (await screen.findByLabelText(
      "Task over-budget limit in USD",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });

    expect(
      await screen.findByText("Enter an amount greater than $0."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(rpcCall("settings/update")).toBeUndefined();
  });
});
