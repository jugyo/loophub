import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { RepoOriginSync } from "@/api/types";
import { RepoSidebar } from "./repo-sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSidebar(handlers: Record<string, (params: any) => unknown>) {
  vi.stubGlobal("fetch", mockRpcFetch(handlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RepoSidebar owner="me" repo="proj" />
    </QueryClientProvider>,
  );
}

const synced: RepoOriginSync = {
  has_origin: true,
  branch: "main",
  ahead: 2,
  behind: 1,
};

describe("repo sidebar origin section (#71)", () => {
  it("shows the branch, its ahead/behind arrows, and the Pull button", async () => {
    renderSidebar({ "repos/originSync": () => synced });

    expect(await screen.findByText("main")).toBeTruthy();
    expect(screen.getByLabelText("2 ahead of origin").textContent).toContain(
      "2",
    );
    expect(screen.getByLabelText("1 behind origin").textContent).toContain("1");
    expect(screen.getByRole("button", { name: "Pull" })).toBeTruthy();
  });

  it("hides the sync UI when the repo has no origin remote", async () => {
    renderSidebar({
      "repos/originSync": () => ({
        has_origin: false,
        branch: null,
        ahead: null,
        behind: null,
      }),
    });

    expect(await screen.findByText("No origin remote.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fetch origin" })).toBeNull();
    expect(screen.queryByLabelText(/ahead of origin/)).toBeNull();
    expect(screen.queryByLabelText(/behind of origin/)).toBeNull();
  });

  it("pulls from origin and shows the counts the pull returned", async () => {
    renderSidebar({
      "repos/originSync": () => synced,
      "repos/pullFromOrigin": () => ({ ...synced, ahead: 2, behind: 0 }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Pull" }));

    await waitFor(() =>
      expect(screen.getByLabelText("0 behind origin")).toBeTruthy(),
    );
    expect(rpcCall("repos/pullFromOrigin")?.params).toEqual({
      name: "me/proj",
    });
  });

  it("shows git's message when the pull fails", async () => {
    renderSidebar({
      "repos/originSync": () => synced,
      "repos/pullFromOrigin": () => {
        throw new RpcFault(
          422,
          "git pull --ff-only origin main failed: diverged",
        );
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Pull" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Pull failed: git pull --ff-only origin main failed: diverged",
    );
    // The branch and its counts stay on screen: the refused pull changed nothing.
    expect(screen.getByLabelText("2 ahead of origin")).toBeTruthy();
  });

  it("reports a detached HEAD and leaves nothing to pull into", async () => {
    renderSidebar({
      "repos/originSync": () => ({
        has_origin: true,
        branch: null,
        ahead: null,
        behind: null,
      }),
    });

    expect(await screen.findByText("detached HEAD")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pull" }).hasAttribute("disabled"),
    ).toBe(true);
    // Fetch refreshes the remote-tracking refs without touching the checkout, so unlike the Pull
    // button it stays usable on a detached HEAD.
    expect(
      screen
        .getByRole("button", { name: "Fetch origin" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("says the branch is not on origin yet when it has no remote-tracking ref", async () => {
    renderSidebar({
      "repos/originSync": () => ({
        has_origin: true,
        branch: "feature/new",
        ahead: null,
        behind: null,
      }),
    });

    expect(await screen.findByText("not on origin yet")).toBeTruthy();
    expect(screen.queryByLabelText(/ahead of origin/)).toBeNull();
  });

  it("fetches from origin and shows the counts the fetch returned", async () => {
    renderSidebar({
      "repos/originSync": () => synced,
      "repos/fetchFromOrigin": () => ({ ...synced, behind: 3 }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Fetch origin" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("3 behind origin")).toBeTruthy(),
    );
    expect(rpcCall("repos/fetchFromOrigin")?.params).toEqual({
      name: "me/proj",
    });
  });

  it("shows git's message when the fetch fails", async () => {
    renderSidebar({
      "repos/originSync": () => synced,
      "repos/fetchFromOrigin": () => {
        throw new RpcFault(422, "git fetch origin failed: unreachable");
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Fetch origin" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Fetch failed: git fetch origin failed: unreachable",
    );
    // The branch and its counts stay on screen: the refused fetch changed nothing.
    expect(screen.getByLabelText("2 ahead of origin")).toBeTruthy();
  });

  it("disables the refresh button while the fetch is running", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    renderSidebar({
      "repos/originSync": () => synced,
      "repos/fetchFromOrigin": () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Fetch origin" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Fetch origin" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );

    resolveFetch({ ...synced, ahead: 0, behind: 0 });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Fetch origin" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });
});
