import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { GlobalSettings, Theme } from "@/api/types";
import { ThemeToggle } from "./theme-toggle";

const initialSettings: GlobalSettings = {
  agents: {
    "claude-code": { model: "opus", effort: "medium" },
    codex: { model: "gpt-5.6-sol", effort: "medium" },
    grok: { model: "grok-code-fast-1", effort: "medium" },
  },
  codingAgent: "claude-code",
  devCostLimitUsd: 10,
  theme: null,
  workflowContractLanguage: "en",
};

let savedTheme: Theme | null;

beforeEach(() => {
  savedTheme = null;
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "settings/get": () => ({ ...initialSettings, theme: savedTheme }),
      "settings/update": (params) => {
        savedTheme = params.theme as Theme;
        return { ...initialSettings, theme: savedTheme };
      },
    }),
  );
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: !query.includes("light"), // OS prefers dark
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("selects themes and persists the choice on the server", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeToggle />
      </QueryClientProvider>,
    );
    const trigger = screen.getByRole("button", { name: "Theme" });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /solarized light/i }),
    );
    await waitFor(() => expect(savedTheme).toBe("solarized"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-solarized")).toBe(
      true,
    );
    expect(document.documentElement.dataset.theme).toBe("solarized");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /midnight/i }));
    await waitFor(() => expect(savedTheme).toBe("midnight"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-midnight")).toBe(
      true,
    );
  });
});
