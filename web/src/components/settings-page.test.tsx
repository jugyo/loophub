import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

function mockFetch(
  initialAutoModeOnBuild = false,
  initialCodingAgent: CodingAgent = "claude-code",
) {
  let autoModeOnBuild = initialAutoModeOnBuild;
  let codingAgent = initialCodingAgent;
  return mockRpcFetch({
    "settings/get": () => ({
      autoModeOnBuild,
      codingAgent,
    }),
    "settings/update": (p) => {
      if (p.autoModeOnBuild !== undefined) autoModeOnBuild = p.autoModeOnBuild;
      if (p.codingAgent) codingAgent = p.codingAgent;
      return { autoModeOnBuild, codingAgent };
    },
  });
}

function renderSettings(
  initialAutoModeOnBuild = false,
  initialCodingAgent: CodingAgent = "claude-code",
) {
  vi.stubGlobal("fetch", mockFetch(initialAutoModeOnBuild, initialCodingAgent));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  it("shows the current auto-mode-on-Build setting as checked", async () => {
    renderSettings(true);
    // The label ("On"/"Off") and hint text are adjacent in the accessible name, so scope the
    // query to the radiogroup and pick by position instead of matching the name by text.
    const group = await screen.findByRole("radiogroup", {
      name: /auto mode on build/i,
    });
    const [offOption, onOption] = within(group).getAllByRole("radio");
    await waitFor(() =>
      expect(onOption.getAttribute("aria-checked")).toBe("true"),
    );
    expect(offOption.getAttribute("aria-checked")).toBe("false");
  });

  it("switches auto-mode-on-Build and persists via settings/update", async () => {
    renderSettings(false);
    const group = await screen.findByRole("radiogroup", {
      name: /auto mode on build/i,
    });
    const [, onOption] = within(group).getAllByRole(
      "radio",
    ) as HTMLButtonElement[];
    await waitFor(() => expect(onOption.disabled).toBe(false));
    fireEvent.click(onOption);

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ autoModeOnBuild: true });
    });
    await waitFor(() =>
      expect(onOption.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("shows the current coding agent as checked", async () => {
    renderSettings(false, "codex");
    // "Claude Code" also appears in the Auto-mode-on-Build hint text ("--auto for Claude
    // Code"), so an unscoped name match is ambiguous — scope to the Coding agent radiogroup.
    const group = await screen.findByRole("radiogroup", {
      name: /coding agent/i,
    });
    const [claudeCodeOption, codexOption] = within(group).getAllByRole("radio");
    await waitFor(() =>
      expect(codexOption.getAttribute("aria-checked")).toBe("true"),
    );
    expect(claudeCodeOption.getAttribute("aria-checked")).toBe("false");
  });

  it("switches the coding agent and persists via settings/update", async () => {
    renderSettings(false, "claude-code");
    const group = await screen.findByRole("radiogroup", {
      name: /coding agent/i,
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
});
