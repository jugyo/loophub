import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { GithubPrStatus, GithubPull } from "@/api/types";
import { GithubPrStatusSection } from "./github-pr-status";

const PULL: GithubPull = {
  number: 42,
  url: "https://github.com/me/proj/pull/42",
  branch: "feature/x",
  created_by: "impl-bot",
  created_at: "2026-06-19T00:00:00Z",
  github_merged: false,
  github_merged_at: null,
  pushed_sha: null,
};

const BASE: GithubPrStatus = {
  state: "open",
  merged: false,
  mergeable: "conflicting",
  review_decision: "changes_requested",
  checks: "failure",
  comments: 3,
  reviews: 2,
  updated_at: "2026-07-01T00:00:00Z",
  synced_at: "2026-07-01T00:00:30Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The section owns the unlink mutation, so every render needs a query client. `unlinkHandler` stubs
 * `pulls/unlinkGithubPull`; the default stub answers successfully.
 */
function renderSection(
  props: Partial<Parameters<typeof GithubPrStatusSection>[0]> = {},
  unlinkHandler: (params: any) => unknown = () => ({
    unlinked: true,
    github_number: 42,
  }),
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({ "pulls/unlinkGithubPull": unlinkHandler }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubPrStatusSection
        owner="me"
        repo="proj"
        number={7}
        githubPull={PULL}
        status={BASE}
        isLoading={false}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("GithubPrStatusSection", () => {
  it("shows successful checks as a green Passed badge", () => {
    const { getByText, queryByText } = renderSection({
      status: { ...BASE, checks: "success" },
    });

    const passedBadge = getByText("Passed");
    expect(queryByText("Passing")).toBeNull();
    expect(passedBadge.className).toContain("border-green-600/60");
    expect(passedBadge.className).toContain("text-green-600");
    expect(passedBadge.className).toContain("dark:text-green-400");
  });

  it("renders the badges, distinctly-labeled counts, and freshness for a linked GitHub PR (#850)", () => {
    const { container } = renderSection();
    const text = container.textContent ?? "";
    expect(text).toContain("GitHub PR");
    expect(text).toContain("Open");
    expect(text).toContain("Changes requested");
    expect(text).toContain("Failing");
    expect(text).toContain("Conflicts");
    // Two counts, each labeled — a reader can't confuse conversation comments with reviews.
    expect(text).toContain("3 comments");
    expect(text).toContain("2 reviews");
    expect(text).toContain("synced");
  });

  it("links to the GitHub PR from the section body in a new tab, showing its URL path (#2091)", () => {
    const { getByRole, getByText } = renderSection();

    // The heading is plain text; the link lives in the body.
    expect(getByRole("heading").textContent).toBe("GitHub PR");
    expect(getByText("GitHub PR").closest("a")).toBeNull();

    // The text carries the owner/repo as well as the number, not a bare `#42`.
    const link = getByRole("link", { name: "me/proj/pull/42" });
    expect(link.getAttribute("href")).toBe(PULL.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe("GitHub PR #42");
  });

  it("shows a URL it can't shorten as-is rather than reducing it to a number (#2091)", () => {
    const { getByRole } = renderSection({
      githubPull: { ...PULL, url: "gh.example.com/me/proj/pull/42" },
    });
    expect(
      getByRole("link", { name: "gh.example.com/me/proj/pull/42" }),
    ).toBeTruthy();
  });

  it("keeps the GitHub PR link while the status is still loading (#2091)", () => {
    const { getByRole } = renderSection({
      status: undefined,
      isLoading: true,
    });
    expect(
      getByRole("link", { name: "me/proj/pull/42" }).getAttribute("href"),
    ).toBe(PULL.url);
  });

  it("shows Merged for a GitHub-merged PR and hides the checks/mergeable rows when unknown/none (#850)", () => {
    const { container } = renderSection({
      status: {
        ...BASE,
        state: "merged",
        merged: true,
        review_decision: "approved",
        checks: "none",
        mergeable: "unknown",
      },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Merged");
    expect(text).toContain("Approved");
    // none checks / unknown mergeable rows are omitted to keep the panel compact.
    expect(text).not.toContain("Checks");
    expect(text).not.toContain("Mergeable");
  });

  it("renders a loading state while fetching (#850)", () => {
    const { container } = renderSection({ status: undefined, isLoading: true });
    expect(container.textContent ?? "").toContain("Loading GitHub status…");
  });

  it("renders a fetch-failed state when there is no status to show (#850)", () => {
    const { container } = renderSection({ status: undefined });
    expect(container.textContent ?? "").toContain(
      "Failed to load GitHub status.",
    );
  });

  it("keeps showing the last-loaded status during a failed background refetch (#850)", () => {
    // React Query keeps `data` on a failed refetch; isLoading is false with data present. The panel
    // must stay on the data branch, not flip to the error box.
    const { container } = renderSection();
    const text = container.textContent ?? "";
    expect(text).toContain("Open");
    expect(text).not.toContain("Failed to load GitHub status.");
  });

  it("confirms before unlinking, saying the GitHub PR itself is untouched (#2384)", async () => {
    const { getByRole, findByRole } = renderSection();

    fireEvent.click(getByRole("button", { name: /Unlink GitHub PR/i }));
    const dialog = await findByRole("dialog", {
      name: /Unlink GitHub PR #42\?/i,
    });
    const text = dialog.textContent ?? "";
    // The scope of the action is spelled out: the LoopHub link only, and it can be redone.
    expect(text).toContain("me/proj/pull/42");
    expect(text).toContain(
      "The pull request on GitHub is not closed or changed",
    );
    expect(text).toContain("you can create a GitHub PR again");
    // Nothing is sent until the confirmation is accepted.
    expect(rpcCall("pulls/unlinkGithubPull")).toBeFalsy();
  });

  it("unlinks on confirm and cancels without a request (#2384)", async () => {
    const { getByRole, queryByRole, findByRole } = renderSection();

    // Cancel leaves the link alone.
    fireEvent.click(getByRole("button", { name: /Unlink GitHub PR/i }));
    await findByRole("dialog");
    fireEvent.click(getByRole("button", { name: /Cancel/i }));
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(rpcCall("pulls/unlinkGithubPull")).toBeFalsy();

    // Confirming sends the unlink for this PR.
    fireEvent.click(getByRole("button", { name: /Unlink GitHub PR/i }));
    await findByRole("dialog");
    fireEvent.click(getByRole("button", { name: /^Unlink$/ }));
    await waitFor(() => expect(rpcCall("pulls/unlinkGithubPull")).toBeTruthy());
    expect(rpcCall("pulls/unlinkGithubPull")!.params).toMatchObject({
      repo: "me/proj",
      number: 7,
    });
  });

  it("keeps the dialog open and shows the failure when the unlink fails (#2384)", async () => {
    const { getByRole, findByRole } = renderSection({}, () => {
      throw new RpcFault(409, "PR #7 has no GitHub PR to unlink");
    });

    fireEvent.click(getByRole("button", { name: /Unlink GitHub PR/i }));
    const dialog = await findByRole("dialog");
    fireEvent.click(getByRole("button", { name: /^Unlink$/ }));

    await waitFor(() =>
      expect(dialog.textContent ?? "").toContain(
        "Unlink failed: PR #7 has no GitHub PR to unlink",
      ),
    );
    expect(getByRole("dialog")).toBeTruthy();
  });
});
