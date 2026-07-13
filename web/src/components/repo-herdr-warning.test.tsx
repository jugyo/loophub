import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  currentRepo: "loophub/loophub" as string | null,
  repos: undefined as unknown,
  sessions: undefined as unknown,
  sessionsError: false,
}));

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({ data: state.repos }),
}));
vi.mock("@/queries/terminal", () => ({
  useHerdrSessions: () => ({
    data: state.sessions,
    isError: state.sessionsError,
  }),
}));
vi.mock("@/lib/use-current-repo", () => ({
  useCurrentRepo: () => state.currentRepo,
}));

import { RepoHerdrWarning } from "./repo-herdr-warning";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  state.currentRepo = "loophub/loophub";
  state.repos = undefined;
  state.sessions = undefined;
  state.sessionsError = false;
});

describe("RepoHerdrWarning", () => {
  it("warns when the repo session is not running and copies the start command", async () => {
    state.repos = [
      {
        full_name: "loophub/loophub",
        herdr_session_name: "loophub-loophub-abcd1234",
      },
    ];
    state.sessions = { repos: [], running_repos: [] };
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<RepoHerdrWarning />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/not running/i)).toBeTruthy();
    const command = "herdr --session loophub-loophub-abcd1234";
    expect(screen.getByText(command)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(command);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy(),
    );
  });

  it.each([
    [
      "the session is running",
      { repos: [], running_repos: ["loophub/loophub"] },
      false,
      "loophub/loophub",
    ],
    ["the running state is unknown", { repos: [] }, false, "loophub/loophub"],
    [
      "the sessions request failed",
      { repos: [], running_repos: [] },
      true,
      "loophub/loophub",
    ],
    [
      "the route is not repo-scoped",
      { repos: [], running_repos: [] },
      false,
      null,
    ],
  ])("renders nothing when %s", (_label, sessions, sessionsError, currentRepo) => {
    state.repos = [
      {
        full_name: "loophub/loophub",
        herdr_session_name: "loophub-loophub-abcd1234",
      },
    ];
    state.sessions = sessions;
    state.sessionsError = sessionsError;
    state.currentRepo = currentRepo;

    const { container } = render(<RepoHerdrWarning />);
    expect(container.firstChild).toBeNull();
  });
});
