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

type AgentSettings = {
  model: string;
  effort: string;
  modelOverride: string;
  effortOverride: string;
};

// The screen edits the override; the resolved model/effort ride along for other readers, so the
// fixture keeps both in sync the way the settings service does.
function saved(model: string, effort: string): AgentSettings {
  return { model, effort, modelOverride: model, effortOverride: effort };
}

const DEFAULT_AGENT_SETTINGS: Record<CodingAgent, AgentSettings> = {
  "claude-code": saved("opus", "medium"),
  codex: saved("gpt-5.5", "medium"),
  grok: saved("grok-code-fast-1", "medium"),
  opencode: saved("opencode/big-pickle", ""),
};

function renderSettings(
  initialCodingAgent: CodingAgent = "claude-code",
  initialDevCostLimitUsd = 10,
  agentOverrides: Partial<Record<CodingAgent, AgentSettings>> = {},
) {
  const agents = {
    ...structuredClone(DEFAULT_AGENT_SETTINGS),
    ...agentOverrides,
  };
  let codingAgent = initialCodingAgent;
  let devCostLimitUsd = initialDevCostLimitUsd;
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => ({
        agents,
        codingAgent,
        devCostLimitUsd,
        workflowContractLanguage: "en",
        publicOrigin: null,
      }),
      "settings/update": (params) => {
        if (params.agent && params.model !== undefined) {
          agents[params.agent as CodingAgent].modelOverride =
            params.model as string;
        }
        if (params.agent && params.effort !== undefined) {
          agents[params.agent as CodingAgent].effortOverride =
            params.effort as string;
        }
        if (params.codingAgent) codingAgent = params.codingAgent as CodingAgent;
        if (params.devCostLimitUsd !== undefined) {
          devCostLimitUsd = params.devCostLimitUsd as number;
        }
        return {
          agents,
          codingAgent,
          devCostLimitUsd,
          workflowContractLanguage: "en",
          publicOrigin: null,
        };
      },
    }),
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function openDropdown(label: string): Promise<HTMLElement> {
  fireEvent.pointerDown(await screen.findByRole("button", { name: label }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.findByRole("menu");
}

function lastRpcCall(
  method: string,
): { method: string; params: any } | undefined {
  const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  for (const call of [...calls].reverse()) {
    const body = JSON.parse(String((call[1] as RequestInit).body));
    if (body.method === method) return body;
  }
  return undefined;
}

describe("SettingsPage", () => {
  it("shows one setting row for every registry runtime", async () => {
    renderSettings();
    const group = await screen.findByRole("radiogroup", {
      name: "Coding agent",
    });
    expect(within(group).getAllByRole("radio")).toHaveLength(4);
    expect(within(group).getByText("Claude Code")).toBeTruthy();
    expect(within(group).getByText("OpenCode")).toBeTruthy();
    expect(within(group).queryByText("—")).toBeNull();
  });

  it("shows the saved model and effort on the closed dropdown", async () => {
    renderSettings();
    const trigger = await screen.findByRole("button", {
      name: "Claude Code model",
    });
    expect(trigger.textContent).toContain("Opus · Medium");
    expect(trigger.getAttribute("title")).toBe("Opus · Medium");
  });

  it("omits the effort when it is unset or the agent has no effort levels", async () => {
    renderSettings("claude-code", 10, {
      "claude-code": saved("opus", ""),
    });
    const withoutEffort = await screen.findByRole("button", {
      name: "Claude Code model",
    });
    expect(withoutEffort.textContent).toBe("Opus");
    expect(withoutEffort.getAttribute("title")).toBe("Opus");
  });

  it("marks and persists the default agent", async () => {
    renderSettings();
    const marker = await screen.findByRole("radio", { name: "Codex" });
    expect((marker as HTMLInputElement).checked).toBe(false);
    fireEvent.click(marker);
    await waitFor(() =>
      expect(lastRpcCall("settings/update")?.params).toMatchObject({
        codingAgent: "codex",
      }),
    );
    expect((marker as HTMLInputElement).checked).toBe(true);
  });

  it("opens the effort submenu from a model option", async () => {
    renderSettings();
    expect(
      (await screen.findByRole("button", { name: "Claude Code model" }))
        .textContent,
    ).toContain("Opus");
    const modelMenu = await openDropdown("Claude Code model");
    const modelOption = within(modelMenu).getByRole("menuitem", {
      name: "Claude Opus 5 effort options",
    });
    fireEvent.pointerMove(modelOption, { pointerType: "mouse" });
    expect(
      await screen.findByRole("menuitem", { name: "Extra high" }),
    ).toBeTruthy();
  });

  it("persists model and effort independently", async () => {
    renderSettings();
    const modelMenu = await openDropdown("Claude Code model");
    const modelOption = within(modelMenu).getByRole("menuitem", {
      name: "Claude Opus 4 8 effort options",
    });
    fireEvent.pointerMove(modelOption, { pointerType: "mouse" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Extra high" }),
    );
    await waitFor(() =>
      expect(lastRpcCall("settings/update")?.params).toMatchObject({
        agent: "claude-code",
        model: "claude-opus-4-8",
        effort: "xhigh",
      }),
    );
  });

  // #362: this screen edits the same override the repo Agent settings do, so Default is offered
  // here too and clears the per-agent override rather than saving a value.
  it("shows Default as the current selection while no override is saved", async () => {
    renderSettings("claude-code", 10, {
      "claude-code": {
        model: "opus",
        effort: "medium",
        modelOverride: "",
        effortOverride: "",
      },
    });
    const trigger = await screen.findByRole("button", {
      name: "Claude Code model",
    });
    expect(trigger.textContent).toBe("Default");

    const modelMenu = await openDropdown("Claude Code model");
    expect(
      within(modelMenu).getByRole("menuitem", {
        name: "Default effort options",
      }).className,
    ).toContain("bg-accent");
  });

  it("clears the override when Default is picked", async () => {
    renderSettings();
    const modelMenu = await openDropdown("Claude Code model");
    const defaultOption = within(modelMenu).getByRole("menuitem", {
      name: "Default effort options",
    });
    fireEvent.pointerMove(defaultOption, { pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Default" }));

    await waitFor(() =>
      expect(lastRpcCall("settings/update")?.params).toMatchObject({
        agent: "claude-code",
        model: "",
        effort: "",
      }),
    );
    expect(
      (await screen.findByRole("button", { name: "Claude Code model" }))
        .textContent,
    ).toBe("Default");
  });

  it("shows and saves the task over-budget limit", async () => {
    renderSettings("claude-code", 12.5);
    const input = (await screen.findByLabelText(
      "Task over-budget limit in USD",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("12.50"));
    fireEvent.change(input, { target: { value: "7.25" } });
    fireEvent.click(
      within(input.closest("form")!).getByRole("button", { name: "Save" }),
    );
    await waitFor(() =>
      expect(rpcCall("settings/update")?.params).toMatchObject({
        devCostLimitUsd: 7.25,
      }),
    );
  });

  it("does not show the public origin on the Agent page", async () => {
    renderSettings();
    await screen.findByRole("heading", { name: "Coding agent" });
    expect(screen.queryByLabelText("Public origin")).toBeNull();
  });
});
