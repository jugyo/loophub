import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

describe("GithubPrStatusSection", () => {
  it("shows successful checks as a green Passed badge", () => {
    const { getByText, queryByText } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={{ ...BASE, checks: "success" }}
        isLoading={false}
      />,
    );

    const passedBadge = getByText("Passed");
    expect(queryByText("Passing")).toBeNull();
    expect(passedBadge.className).toContain("border-green-600/60");
    expect(passedBadge.className).toContain("text-green-600");
    expect(passedBadge.className).toContain("dark:text-green-400");
  });

  it("renders the badges, distinctly-labeled counts, and freshness for a linked GitHub PR (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={BASE}
        isLoading={false}
      />,
    );
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
    const { getByRole, getByText } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={BASE}
        isLoading={false}
      />,
    );

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
    const { getByRole } = render(
      <GithubPrStatusSection
        githubPull={{ ...PULL, url: "gh.example.com/me/proj/pull/42" }}
        status={BASE}
        isLoading={false}
      />,
    );
    expect(
      getByRole("link", { name: "gh.example.com/me/proj/pull/42" }),
    ).toBeTruthy();
  });

  it("keeps the GitHub PR link while the status is still loading (#2091)", () => {
    const { getByRole } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={undefined}
        isLoading={true}
      />,
    );
    expect(
      getByRole("link", { name: "me/proj/pull/42" }).getAttribute("href"),
    ).toBe(PULL.url);
  });

  it("shows Merged for a GitHub-merged PR and hides the checks/mergeable rows when unknown/none (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={{
          ...BASE,
          state: "merged",
          merged: true,
          review_decision: "approved",
          checks: "none",
          mergeable: "unknown",
        }}
        isLoading={false}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Merged");
    expect(text).toContain("Approved");
    // none checks / unknown mergeable rows are omitted to keep the panel compact.
    expect(text).not.toContain("Checks");
    expect(text).not.toContain("Mergeable");
  });

  it("renders a loading state while fetching (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={undefined}
        isLoading={true}
      />,
    );
    expect(container.textContent ?? "").toContain("Loading GitHub status…");
  });

  it("renders a fetch-failed state when there is no status to show (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={undefined}
        isLoading={false}
      />,
    );
    expect(container.textContent ?? "").toContain(
      "Failed to load GitHub status.",
    );
  });

  it("keeps showing the last-loaded status during a failed background refetch (#850)", () => {
    // React Query keeps `data` on a failed refetch; isLoading is false with data present. The panel
    // must stay on the data branch, not flip to the error box.
    const { container } = render(
      <GithubPrStatusSection
        githubPull={PULL}
        status={BASE}
        isLoading={false}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Open");
    expect(text).not.toContain("Failed to load GitHub status.");
  });
});
