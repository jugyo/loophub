import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAgent } from "@/api/types";
import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import { CODING_AGENTS } from "../../../core/runtimes.ts";
import {
  agentConfigSummary,
  CodingAgentSettingsList,
} from "./coding-agent-settings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderList(
  props: Partial<Parameters<typeof CodingAgentSettingsList>[0]> = {},
) {
  const onSelectAgent = vi.fn();
  const onSaveModel = vi.fn();
  render(
    <CodingAgentSettingsList
      name="coding-agent"
      label="Coding agent"
      selected="claude-code"
      values={{ "claude-code": { model: "opus", effort: "medium" } }}
      disabled={false}
      saving={false}
      onSelectAgent={onSelectAgent}
      onSaveModel={onSaveModel}
      {...props}
    />,
  );
  return { onSelectAgent, onSaveModel };
}

async function openDropdown(label: string): Promise<HTMLElement> {
  fireEvent.pointerDown(await screen.findByRole("button", { name: label }), {
    button: 0,
    ctrlKey: false,
  });
  return screen.findByRole("menu");
}

describe("CodingAgentSettingsList", () => {
  // The application Settings screen and the per-repo Agent settings differ only in the repo's
  // override semantics (`allowDefault`), so the rows they render must stay identical (#165).
  it("renders the same row per registry runtime whether or not Default is offered", () => {
    for (const allowDefault of [false, true]) {
      const { unmount } = render(
        <CodingAgentSettingsList
          name="coding-agent"
          label="Coding agent"
          selected="codex"
          values={{ codex: { model: "gpt-5.5", effort: "high" } }}
          allowDefault={allowDefault}
          disabled={false}
          saving={false}
          onSelectAgent={() => {}}
          onSaveModel={() => {}}
        />,
      );
      const group = screen.getByRole("radiogroup", { name: "Coding agent" });
      expect(within(group).getAllByRole("radio")).toHaveLength(
        CODING_AGENTS.length,
      );
      for (const agent of CODING_AGENTS) {
        const label = CODING_AGENT_LABELS[agent];
        expect(within(group).getByRole("radio", { name: label })).toBeTruthy();
        expect(
          within(group).getByRole("button", { name: `${label} model` }),
        ).toBeTruthy();
      }
      expect(
        screen.getByRole("button", { name: "Codex model" }).textContent,
      ).toBe("GPT 5.5 · High");
      unmount();
    }
  });

  it("reports the picked agent, model and effort to the caller", async () => {
    const { onSelectAgent, onSaveModel } = renderList();

    fireEvent.click(screen.getByRole("radio", { name: "Codex" }));
    expect(onSelectAgent).toHaveBeenCalledWith("codex");

    const menu = await openDropdown("Codex model");
    fireEvent.pointerMove(
      within(menu).getByRole("menuitem", { name: "GPT 5.5 effort options" }),
      { pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Minimal" }));
    expect(onSaveModel).toHaveBeenCalledWith("codex", "gpt-5.5", "minimal");
  });

  // The repo override stores an empty model/effort as "use the runtime default", so that screen
  // needs a way back to it even once a concrete model is saved.
  it("offers a Default entry for a saved model only when the caller allows it", async () => {
    const saved = {
      selected: "codex" as CodingAgent,
      values: { codex: { model: "gpt-5.5", effort: "high" } },
    };
    renderList({ ...saved, allowDefault: true });
    const withDefault = await openDropdown("Codex model");
    expect(
      within(withDefault).getByRole("menuitem", {
        name: "Default effort options",
      }),
    ).toBeTruthy();

    cleanup();
    renderList(saved);
    const withoutDefault = await openDropdown("Codex model");
    expect(
      within(withoutDefault).queryByRole("menuitem", {
        name: "Default effort options",
      }),
    ).toBeNull();
  });

  it("keeps a saved value outside the suggestions visible", async () => {
    renderList({
      selected: "codex",
      values: { codex: { model: "gpt-legacy", effort: "high" } },
    });
    expect(
      screen.getByRole("button", { name: "Codex model" }).textContent,
    ).toBe("GPT Legacy · High");
    const menu = await openDropdown("Codex model");
    expect(
      within(menu).getByRole("menuitem", { name: "GPT Legacy effort options" }),
    ).toBeTruthy();
  });

  it("summarizes an effective config the way the rows label it", () => {
    expect(
      agentConfigSummary({
        runtime: "claude-code" as CodingAgent,
        model: "opus",
        effort: "xhigh",
      }),
    ).toBe("Claude Code · Opus · Extra high");
  });
});
