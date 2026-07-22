import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchTerminal } = vi.hoisted(() => ({ launchTerminal: vi.fn() }));
let workflowContractLanguage: string | undefined = "en";
vi.mock("@/components/terminal-controller", () => ({
  useTerminalLauncher: () => ({ launchTerminal }),
}));
vi.mock("@/queries/settings", () => ({
  useSettings: () => ({
    data: {
      agents: {
        "claude-code": { model: "opus", effort: "medium" },
        codex: { model: "gpt-5.5", effort: "medium" },
        grok: { model: "grok-code-fast-1", effort: "medium" },
      },
      codingAgent: "claude-code",
      workflowContractLanguage,
    },
  }),
}));
vi.mock("@/queries/repos", () => ({
  useRepoAgentConfig: () => ({
    data: {
      setting: {
        override: false,
        runtime: null,
        model: null,
        effort: null,
      },
      effective: {
        runtime: "claude-code",
        model: "opus",
        effort: "medium",
      },
    },
  }),
}));

import { CreateIssueButton } from "./create-issue-button";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  launchTerminal.mockClear();
  workflowContractLanguage = "en";
});

describe("CreateIssueButton", () => {
  it("renders a New issue button", () => {
    render(<CreateIssueButton repo="me/proj" />);
    expect(screen.getByRole("button", { name: /new issue/i })).toBeTruthy();
  });

  it("dispatches the issue-create workflow with direct filing instructions", () => {
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
      prompt: expect.stringContaining("Create an AFK-ready LoopHub issue"),
    });
  });

  it("uses the selected workflow language for issue creation instructions", () => {
    workflowContractLanguage = "ja";
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "ユーザーの依頼から AFK 対応の LoopHub issue",
        ),
      }),
    );
    expect(launchTerminal.mock.calls[0][0].prompt).not.toContain(
      "Create an AFK-ready LoopHub issue",
    );
  });

  it("falls back to English for an unsupported workflow language", () => {
    workflowContractLanguage = "fr";
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal.mock.calls[0][0].prompt).toContain(
      "Create an AFK-ready LoopHub issue",
    );
  });

  it("forwards the workspace branch to issue creation", () => {
    render(<CreateIssueButton repo="me/proj" targetBranch="workspace/alpha" />);

    expect(screen.getByText("in workspace/alpha")).toBeTruthy();
    expect(screen.getByRole("button", { name: /new issue/i }).textContent).toBe(
      "New issue",
    );
    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

    expect(launchTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ targetBranch: "workspace/alpha" }),
    );
  });

  it("keeps a long workspace name out of the action button", () => {
    render(
      <CreateIssueButton
        repo="me/proj"
        targetBranch="workspace/with-a-very-long-name-that-should-not-wrap-the-button"
      />,
    );

    const button = screen.getByRole("button", { name: /new issue/i });
    expect(button.textContent).toBe("New issue");
    expect(
      screen.getByText(
        "in workspace/with-a-very-long-name-that-should-not-wrap-the-button",
      ).className,
    ).toContain("text-xs");
  });

  it("launches issue creation with a suggested one-shot agent, model, and effort", async () => {
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Choose agent and model",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Model" }));
    const codexModelMenu = (
      await screen.findByRole("menuitem", { name: "gpt-5.6-sol" })
    ).closest('[role="menu"]')!;
    expect(
      within(codexModelMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent)
        .filter((item) => item?.startsWith("gpt-")),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "gpt-5.6-sol" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Effort" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "high" }));
    fireEvent.click(screen.getByRole("button", { name: "Create with Codex" }));

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
      agent: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: expect.stringContaining("Create an AFK-ready LoopHub issue"),
    });
  });

  it("launches issue creation with a custom one-shot model", () => {
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Choose agent and model",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.change(screen.getByLabelText("Custom model"), {
      target: { value: "vendor/custom-preview" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create with Claude Code" }),
    );

    expect(launchTerminal).toHaveBeenCalledWith({
      repo: "me/proj",
      label: expect.stringMatching(/^New issue - [a-z0-9]+$/i),
      workflow: "issue-create",
      agent: "claude-code",
      model: "vendor/custom-preview",
      effort: "medium",
      prompt: expect.stringContaining("Create an AFK-ready LoopHub issue"),
    });
  });

  it("renders as a regular button instead of a fixed floating action button", () => {
    render(<CreateIssueButton repo="me/proj" />);
    const button = screen.getByRole("button", { name: /new issue/i });
    expect(button.textContent).toContain("New issue");
    expect(button.className).not.toContain("fixed");
    expect(button.className).not.toContain("rounded-full");
  });

  it("gives each consecutive launch a distinct agent name label", () => {
    render(<CreateIssueButton repo="me/proj" />);

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const first = launchTerminal.mock.calls[0][0].label;
    launchTerminal.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /new issue/i }));
    const second = launchTerminal.mock.calls[0][0].label;

    expect(first).not.toBe(second);
  });
});
