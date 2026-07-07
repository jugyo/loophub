import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const repoData = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@/queries/repos", () => ({
  useRepo: () => ({ data: repoData.value }),
}));

import { RepoHerdrCommand } from "./repo-herdr-command";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  repoData.value = undefined;
});

describe("RepoHerdrCommand", () => {
  it("renders the repo's herdr start/connect command and copies it", async () => {
    repoData.value = { herdr_session_name: "loophub-loophub-abcd1234" };
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(<RepoHerdrCommand owner="loophub" repo="loophub" />);

    expect(screen.getByText(/herdr session/i)).toBeTruthy();
    const command = "herdr --session loophub-loophub-abcd1234";
    expect(screen.getByText(command)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(command);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy(),
    );
  });

  it("renders nothing until the repo session name is known", () => {
    repoData.value = undefined;
    const { container } = render(
      <RepoHerdrCommand owner="loophub" repo="loophub" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
