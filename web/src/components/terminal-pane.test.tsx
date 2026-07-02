import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const currentRepo = vi.hoisted(() => ({ value: "jugyo/loophub" }));
vi.mock("@/lib/use-current-repo", () => ({
  useCurrentRepo: () => currentRepo.value,
}));

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({ data: [] }),
}));

const terminalLaunchConfig = vi.hoisted(() => ({
  value: {
    isSuccess: false,
    isPending: true,
    data: undefined as { backend: "builtin" | "herdr" } | undefined,
  },
}));
vi.mock("@/queries/terminal", () => ({
  useTerminalLaunchConfig: () => terminalLaunchConfig.value,
}));

vi.mock("@/components/terminal-view", () => ({
  TerminalView: (props: { repo: string; active: boolean }) => (
    <div
      data-active={String(props.active)}
      data-repo={props.repo}
      data-testid="terminal-view"
    />
  ),
}));

import { TerminalPane } from "./terminal-pane";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  currentRepo.value = "jugyo/loophub";
  terminalLaunchConfig.value = {
    isSuccess: false,
    isPending: true,
    data: undefined,
  };
});

describe("TerminalPane", () => {
  it("preserves a restored builtin-open pane while terminal config is loading", async () => {
    sessionStorage.setItem("lh.terminal.open", "1");
    const { rerender } = render(<TerminalPane />);

    expect(screen.queryByTestId("terminal-view")).toBeNull();

    terminalLaunchConfig.value = {
      isSuccess: true,
      isPending: false,
      data: { backend: "builtin" },
    };
    rerender(<TerminalPane />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-view")).toBeTruthy();
    });
    expect(screen.getByTestId("terminal-view").getAttribute("data-repo")).toBe(
      "jugyo/loophub",
    );
  });

  it("does not render or restore the builtin pane for the Herdr backend", () => {
    sessionStorage.setItem("lh.terminal.open", "1");
    terminalLaunchConfig.value = {
      isSuccess: true,
      isPending: false,
      data: { backend: "herdr" },
    };

    const { container } = render(<TerminalPane />);

    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(container.firstChild).toBeNull();
    expect(sessionStorage.getItem("lh.terminal.open")).toBe("0");
  });

  it("collapses a restored pane instead of getting stuck if terminal/config settles into an error (#465)", () => {
    // A query that settles to an error is never isSuccess, so gating restore on `!isSuccess`
    // alone would wait forever. isPending: false (settled) + isSuccess: false (errored) must
    // fall through to the normal collapsed/disabled fallback.
    sessionStorage.setItem("lh.terminal.open", "1");
    terminalLaunchConfig.value = {
      isSuccess: false,
      isPending: false,
      data: undefined,
    };

    render(<TerminalPane />);

    expect(screen.queryByTestId("terminal-view")).toBeNull();
    expect(sessionStorage.getItem("lh.terminal.open")).toBe("0");
  });

  it("does not recreate a tab after the user closes the last builtin tab", async () => {
    terminalLaunchConfig.value = {
      isSuccess: true,
      isPending: false,
      data: { backend: "builtin" },
    };
    render(<TerminalPane />);

    // Two buttons share the "Open terminal" title (the icon toggle and the chevron toggle) —
    // both call the same toggle handler, so either works.
    fireEvent.click(screen.getAllByTitle("Open terminal")[0]);
    await waitFor(() => {
      expect(screen.getByTestId("terminal-view")).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Close tab"));

    await waitFor(() => {
      expect(screen.queryByTestId("terminal-view")).toBeNull();
    });
    expect(sessionStorage.getItem("lh.terminal.open")).toBe("0");
  });
});
