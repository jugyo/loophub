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

const DEFAULT_AGENT_SETTINGS: Record<
  CodingAgent,
  { model: string; effort: string }
> = {
  "claude-code": { model: "opus", effort: "medium" },
  codex: { model: "gpt-5.5", effort: "medium" },
  grok: { model: "grok-code-fast-1", effort: "medium" },
  cursor: { model: "auto", effort: "" },
  opencode: { model: "opencode/big-pickle", effort: "" },
};

function renderSettings(
  initialCodingAgent: CodingAgent = "claude-code",
  initialDevCostLimitUsd = 10,
) {
  const agents = structuredClone(DEFAULT_AGENT_SETTINGS);
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
      }),
      "settings/update": (params) => {
        if (params.agent && params.model !== undefined) {
          agents[params.agent as CodingAgent].model = params.model as string;
        }
        if (params.agent && params.effort !== undefined) {
          agents[params.agent as CodingAgent].effort = params.effort as string;
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
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    expect(within(group).getByText("Claude Code")).toBeTruthy();
    expect(within(group).getByText("OpenCode")).toBeTruthy();
    expect(
      within(group).getByLabelText("Cursor Agent effort not supported")
        .textContent,
    ).toBe("—");
    expect(
      within(group).getByLabelText("OpenCode effort not supported").textContent,
    ).toBe("—");
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

  it("shows and saves the task over-budget limit", async () => {
    renderSettings("claude-code", 12.5);
    const input = (await screen.findByLabelText(
      "Task over-budget limit in USD",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("12.50"));
    fireEvent.change(input, { target: { value: "7.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(rpcCall("settings/update")?.params).toMatchObject({
        devCostLimitUsd: 7.25,
      }),
    );
  });
});
