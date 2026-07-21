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
  autoModeOnLaunch: boolean;
  model: string;
  effort: string;
};

const DEFAULT_AGENT_SETTINGS: Record<CodingAgent, AgentSettingsForTest> = {
  "claude-code": { autoModeOnLaunch: false, model: "opus", effort: "medium" },
  codex: { autoModeOnLaunch: false, model: "gpt-5.5", effort: "medium" },
  grok: {
    autoModeOnLaunch: false,
    model: "grok-code-fast-1",
    effort: "medium",
  },
};

function mockFetch(
  initialAgents: Partial<Record<CodingAgent, AgentSettingsForTest>> = {},
  initialCodingAgent: CodingAgent = "claude-code",
  initialDevCostLimitUsd = 10,
) {
  const agents: Record<CodingAgent, AgentSettingsForTest> = {
    ...DEFAULT_AGENT_SETTINGS,
    ...initialAgents,
  };
  let codingAgent = initialCodingAgent;
  let devCostLimitUsd = initialDevCostLimitUsd;
  return mockRpcFetch({
    "settings/get": () => ({
      agents,
      codingAgent,
      devCostLimitUsd,
    }),
    "settings/update": (p) => {
      if (p.agent && p.autoModeOnLaunch !== undefined) {
        agents[p.agent as CodingAgent] = {
          ...agents[p.agent as CodingAgent],
          autoModeOnLaunch: p.autoModeOnLaunch,
        };
      }
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
      return { agents, codingAgent, devCostLimitUsd };
    },
  });
}

function renderSettings(
  initialAgents?: Partial<Record<CodingAgent, AgentSettingsForTest>>,
  initialCodingAgent: CodingAgent = "claude-code",
  initialDevCostLimitUsd = 10,
) {
  vi.stubGlobal(
    "fetch",
    mockFetch(initialAgents, initialCodingAgent, initialDevCostLimitUsd),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // SettingsPage renders a <Link> to /settings/workflows (#1006), which needs a router context.
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SettingsPage />,
  });
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/workflows",
    component: () => <div data-testid="workflows-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workflowsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
  it("shows Agent and Workflows tabs with Agent selected initially", async () => {
    renderSettings();

    const tablist = await screen.findByRole("tablist", {
      name: "Settings categories",
    });
    const agentTab = within(tablist).getByRole("tab", { name: "Agent" });
    const workflowsTab = within(tablist).getByRole("tab", {
      name: "Workflows",
    });

    expect(agentTab.getAttribute("aria-selected")).toBe("true");
    expect(workflowsTab.getAttribute("aria-selected")).toBe("false");

    const agentPanel = screen.getByRole("tabpanel", { name: "Agent" });
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

  it("keeps each controlled panel in the DOM and hides only the inactive panel", async () => {
    renderSettings();

    const agentTab = await screen.findByRole("tab", { name: "Agent" });
    const workflowsTab = screen.getByRole("tab", { name: "Workflows" });
    const agentPanel = document.getElementById(
      agentTab.getAttribute("aria-controls") ?? "",
    );
    const workflowsPanel = document.getElementById(
      workflowsTab.getAttribute("aria-controls") ?? "",
    );

    expect(agentPanel?.hidden).toBe(false);
    expect(workflowsPanel?.hidden).toBe(true);

    fireEvent.click(workflowsTab);

    expect(agentPanel?.hidden).toBe(true);
    expect(workflowsPanel?.hidden).toBe(false);
  });

  it("switches to the Workflows content and opens workflow management", async () => {
    renderSettings();

    const agentTab = await screen.findByRole("tab", { name: "Agent" });
    const workflowsTab = screen.getByRole("tab", { name: "Workflows" });
    fireEvent.click(workflowsTab);

    expect(agentTab.getAttribute("aria-selected")).toBe("false");
    expect(workflowsTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tabpanel", { name: "Agent" })).toBeNull();

    const workflowsPanel = screen.getByRole("tabpanel", {
      name: "Workflows",
    });
    expect(
      within(workflowsPanel).getByRole("heading", { name: "Workflows" }),
    ).toBeTruthy();
    expect(
      within(workflowsPanel).getByText(/Execute\/Verify prompt bundles/),
    ).toBeTruthy();

    fireEvent.click(
      within(workflowsPanel).getByRole("link", {
        name: "Manage workflows",
      }),
    );
    expect(await screen.findByTestId("workflows-page")).toBeTruthy();
  });

  it("switches tabs with arrow keys and keeps only the selected tab in the tab order", async () => {
    renderSettings();

    const agentTab = await screen.findByRole("tab", { name: "Agent" });
    const workflowsTab = screen.getByRole("tab", { name: "Workflows" });
    expect(agentTab.getAttribute("tabindex")).toBe("0");
    expect(workflowsTab.getAttribute("tabindex")).toBe("-1");

    agentTab.focus();
    fireEvent.keyDown(agentTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(workflowsTab);
    expect(agentTab.getAttribute("tabindex")).toBe("-1");
    expect(workflowsTab.getAttribute("tabindex")).toBe("0");
    expect(workflowsTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(workflowsTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(agentTab);
    expect(agentTab.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the current auto-mode-on-launch setting per agent", async () => {
    renderSettings({
      "claude-code": {
        autoModeOnLaunch: true,
        model: "opus",
        effort: "medium",
      },
      codex: { autoModeOnLaunch: false, model: "gpt-5.5", effort: "medium" },
    });
    // The label ("On"/"Off") and hint text are adjacent in the accessible name, so scope the
    // query to the radiogroup and pick by position instead of matching the name by text.
    const claudeGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on launch \(claude code\)/i,
    });
    const [claudeOff, claudeOn] = within(claudeGroup).getAllByRole("radio");
    await waitFor(() =>
      expect(claudeOn.getAttribute("aria-checked")).toBe("true"),
    );
    expect(claudeOff.getAttribute("aria-checked")).toBe("false");

    const codexGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on launch \(codex\)/i,
    });
    const [codexOff] = within(codexGroup).getAllByRole("radio");
    expect(codexOff.getAttribute("aria-checked")).toBe("true");
  });

  it("switches auto-mode-on-launch for one agent and persists via settings/update, leaving the other agent untouched", async () => {
    renderSettings();
    const claudeGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on launch \(claude code\)/i,
    });
    const [, claudeOn] = within(claudeGroup).getAllByRole(
      "radio",
    ) as HTMLButtonElement[];
    await waitFor(() => expect(claudeOn.disabled).toBe(false));
    fireEvent.click(claudeOn);

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({
        agent: "claude-code",
        autoModeOnLaunch: true,
      });
    });
    await waitFor(() =>
      expect(claudeOn.getAttribute("aria-checked")).toBe("true"),
    );

    const codexGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on launch \(codex\)/i,
    });
    const [codexOff] = within(codexGroup).getAllByRole("radio");
    expect(codexOff.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the current coding agent as checked", async () => {
    renderSettings(undefined, "codex");
    // "Claude Code" also appears in the Auto-mode-on-launch hint text ("--auto for Claude
    // Code"), so an unscoped name match is ambiguous — scope to the Coding agent radiogroup.
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
      "claude-code": { autoModeOnLaunch: false, model: "opus", effort: "high" },
      codex: { autoModeOnLaunch: false, model: "gpt-5.5", effort: "low" },
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
        autoModeOnLaunch: false,
        model: "claude-fable-5",
        effort: "medium",
      },
      codex: { autoModeOnLaunch: false, model: "gpt-5.5", effort: "medium" },
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
        autoModeOnLaunch: false,
        model: "vendor::claude-fable-5",
        effort: "medium",
      },
      codex: { autoModeOnLaunch: false, model: "gpt-5.5", effort: "medium" },
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
