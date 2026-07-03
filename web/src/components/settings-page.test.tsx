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

type AgentSettingsForTest = { autoModeOnBuild: boolean; model: string };

function mockFetch(
  initialAgents: Record<CodingAgent, AgentSettingsForTest> = {
    "claude-code": { autoModeOnBuild: false, model: "opus" },
    codex: { autoModeOnBuild: false, model: "gpt-5.5" },
  },
  initialCodingAgent: CodingAgent = "claude-code",
) {
  const agents = { ...initialAgents };
  let codingAgent = initialCodingAgent;
  return mockRpcFetch({
    "settings/get": () => ({
      agents,
      codingAgent,
    }),
    "settings/update": (p) => {
      if (p.agent && p.autoModeOnBuild !== undefined) {
        agents[p.agent as CodingAgent] = {
          ...agents[p.agent as CodingAgent],
          autoModeOnBuild: p.autoModeOnBuild,
        };
      }
      if (p.agent && p.model !== undefined) {
        agents[p.agent as CodingAgent] = {
          ...agents[p.agent as CodingAgent],
          model: p.model as string,
        };
      }
      if (p.codingAgent) codingAgent = p.codingAgent;
      return { agents, codingAgent };
    },
  });
}

function renderSettings(
  initialAgents?: Record<CodingAgent, AgentSettingsForTest>,
  initialCodingAgent: CodingAgent = "claude-code",
) {
  vi.stubGlobal("fetch", mockFetch(initialAgents, initialCodingAgent));
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
  it("shows the current auto-mode-on-Build setting per agent", async () => {
    renderSettings({
      "claude-code": { autoModeOnBuild: true, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    });
    // The label ("On"/"Off") and hint text are adjacent in the accessible name, so scope the
    // query to the radiogroup and pick by position instead of matching the name by text.
    const claudeGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on build \(claude code\)/i,
    });
    const [claudeOff, claudeOn] = within(claudeGroup).getAllByRole("radio");
    await waitFor(() =>
      expect(claudeOn.getAttribute("aria-checked")).toBe("true"),
    );
    expect(claudeOff.getAttribute("aria-checked")).toBe("false");

    const codexGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on build \(codex\)/i,
    });
    const [codexOff] = within(codexGroup).getAllByRole("radio");
    expect(codexOff.getAttribute("aria-checked")).toBe("true");
  });

  it("switches auto-mode-on-Build for one agent and persists via settings/update, leaving the other agent untouched", async () => {
    renderSettings();
    const claudeGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on build \(claude code\)/i,
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
        autoModeOnBuild: true,
      });
    });
    await waitFor(() =>
      expect(claudeOn.getAttribute("aria-checked")).toBe("true"),
    );

    const codexGroup = await screen.findByRole("radiogroup", {
      name: /auto mode on build \(codex\)/i,
    });
    const [codexOff] = within(codexGroup).getAllByRole("radio");
    expect(codexOff.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the current coding agent as checked", async () => {
    renderSettings(undefined, "codex");
    // "Claude Code" also appears in the Auto-mode-on-Build hint text ("--auto for Claude
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

  it("shows the current default model per agent (#594)", async () => {
    renderSettings({
      "claude-code": { autoModeOnBuild: false, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    });
    const claudeInput = (await screen.findByLabelText(
      "Default model (Claude Code)",
    )) as HTMLInputElement;
    await waitFor(() => expect(claudeInput.value).toBe("opus"));

    const codexInput = (await screen.findByLabelText(
      "Default model (Codex)",
    )) as HTMLInputElement;
    expect(codexInput.value).toBe("gpt-5.5");
  });

  it("updates one agent's default model and persists via settings/update, leaving the other agent untouched (#594)", async () => {
    renderSettings();
    const claudeInput = (await screen.findByLabelText(
      "Default model (Claude Code)",
    )) as HTMLInputElement;
    await waitFor(() => expect(claudeInput.value).toBe("opus"));

    fireEvent.change(claudeInput, { target: { value: "claude-opus-4-8" } });
    fireEvent.submit(claudeInput.closest("form")!);

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({
        agent: "claude-code",
        model: "claude-opus-4-8",
      });
    });
    await waitFor(() => expect(claudeInput.value).toBe("claude-opus-4-8"));

    const codexInput = (await screen.findByLabelText(
      "Default model (Codex)",
    )) as HTMLInputElement;
    expect(codexInput.value).toBe("gpt-5.5");
  });

  it("offers per-agent model suggestions via a datalist, without constraining free text (#610)", async () => {
    renderSettings();
    const claudeInput = (await screen.findByLabelText(
      "Default model (Claude Code)",
    )) as HTMLInputElement;
    await waitFor(() => expect(claudeInput.value).toBe("opus"));

    const claudeListId = claudeInput.getAttribute("list");
    expect(claudeListId).toBeTruthy();
    const claudeOptions = Array.from(
      document.getElementById(claudeListId!)!.querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(claudeOptions).toEqual(
      expect.arrayContaining(["opus", "sonnet", "haiku"]),
    );

    const codexInput = (await screen.findByLabelText(
      "Default model (Codex)",
    )) as HTMLInputElement;
    const codexListId = codexInput.getAttribute("list");
    expect(codexListId).toBeTruthy();
    expect(codexListId).not.toBe(claudeListId);
    const codexOptions = Array.from(
      document.getElementById(codexListId!)!.querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(codexOptions).toEqual(expect.arrayContaining(["gpt-5.5"]));

    // Free text outside the suggestion list is still accepted and saved (#610's core requirement).
    fireEvent.change(claudeInput, { target: { value: "claude-fable-5" } });
    fireEvent.submit(claudeInput.closest("form")!);
    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call!.params).toMatchObject({
        agent: "claude-code",
        model: "claude-fable-5",
      });
    });
  });
});
