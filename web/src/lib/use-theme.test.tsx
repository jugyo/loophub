import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { GlobalSettings } from "@/api/types";
import { getThemeDefinition } from "./theme";
import { useTheme } from "./use-theme";

const { showError } = vi.hoisted(() => ({
  showError: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError }),
}));

const initialSettings: GlobalSettings = {
  agents: {
    "claude-code": { model: "opus", effort: "medium" },
    codex: { model: "gpt-5.6-sol", effort: "medium" },
    grok: { model: "grok-code-fast-1", effort: "medium" },
  },
  codingAgent: "claude-code",
  devCostLimitUsd: 10,
  theme: "light",
  workflowContractLanguage: "en",
};
let serverSettings: GlobalSettings;
let updateFailure: RpcFault | undefined;

function Harness() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme("forest")}>
        Forest
      </button>
    </>
  );
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(["settings"], initialSettings);
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  serverSettings = structuredClone(initialSettings);
  updateFailure = undefined;
  showError.mockClear();
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => serverSettings,
      "settings/update": (params) => {
        if (updateFailure) throw updateFailure;
        serverSettings = { ...serverSettings, theme: params.theme };
        return serverSettings;
      },
    }),
  );
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useTheme", () => {
  it("shows an error toast when saving a selected theme fails", async () => {
    updateFailure = new RpcFault(500, "database is locked");
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Forest" }));

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith(
        "Failed to save theme: database is locked",
      );
    });
    expect(screen.getByTestId("theme").textContent).toBe("forest");
  });

  it("persists a selected theme through settings/update", async () => {
    renderHarness();

    fireEvent.click(screen.getByRole("button", { name: "Forest" }));

    expect(screen.getByTestId("theme").textContent).toBe("forest");
    expect(document.documentElement.dataset.theme).toBe("forest");
    await waitFor(() => {
      expect(rpcCall("settings/update")?.params).toMatchObject({
        theme: "forest",
      });
    });
  });

  it("adopts a server theme refreshed after another tab changes it", async () => {
    const queryClient = renderHarness();
    expect(screen.getByTestId("theme").textContent).toBe("light");

    serverSettings = { ...serverSettings, theme: "midnight" };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    });

    const root = document.documentElement;
    await waitFor(() => {
      expect(screen.getByTestId("theme").textContent).toBe("midnight");
    });
    expect(root.classList.contains("theme-midnight")).toBe(true);
    expect(root.classList.contains("theme-light")).toBe(false);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.theme).toBe("midnight");
    expect(root.style.getPropertyValue("--background")).toBe(
      getThemeDefinition("midnight").tokens.background,
    );
  });
});
