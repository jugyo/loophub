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
import { mockRpcFetch } from "@/api/rpc-mock";
import { AdvancedSettingsPage } from "./advanced-settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAdvancedSettings(initialPublicOrigin: string | null = null) {
  let publicOrigin = initialPublicOrigin;
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => ({
        agents: {},
        codingAgent: "claude-code",
        devCostLimitUsd: 10,
        workflowContractLanguage: "en",
        publicOrigin,
      }),
      "settings/update": (params) => {
        if ("publicOrigin" in params) {
          publicOrigin = params.publicOrigin as string | null;
        }
        return {
          agents: {},
          codingAgent: "claude-code",
          devCostLimitUsd: 10,
          workflowContractLanguage: "en",
          publicOrigin,
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
    component: () => <div>Agent settings</div>,
  });
  const advancedRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/advanced",
    component: () => <AdvancedSettingsPage />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, advancedRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/advanced"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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

describe("AdvancedSettingsPage", () => {
  it("shows the Network access section and navigates from the settings menu", async () => {
    renderAdvancedSettings();

    expect(
      await screen.findByRole("heading", { name: "Network access" }),
    ).toBeTruthy();
    const advancedLink = screen.getByRole("link", { name: "Advanced" });
    expect(advancedLink.getAttribute("href")).toBe("/settings/advanced");
    expect(advancedLink.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Agent" })).toBeTruthy();
  });

  it("shows, saves, reloads, and clears the exact public origin", async () => {
    renderAdvancedSettings("https://loop.example.com");
    const input = (await screen.findByLabelText(
      "Public origin",
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("https://loop.example.com"));

    fireEvent.change(input, { target: { value: "https://new.example.com" } });
    fireEvent.click(
      within(input.closest("form")!).getByRole("button", { name: "Save" }),
    );
    await waitFor(() =>
      expect(lastRpcCall("settings/update")?.params).toMatchObject({
        publicOrigin: "https://new.example.com",
      }),
    );
    await waitFor(() => expect(input.value).toBe("https://new.example.com"));

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(
      within(input.closest("form")!).getByRole("button", { name: "Save" }),
    );
    await waitFor(() =>
      expect(lastRpcCall("settings/update")?.params).toMatchObject({
        publicOrigin: null,
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });
});
