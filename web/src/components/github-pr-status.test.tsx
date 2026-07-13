import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GithubPrStatus } from "@/api/types";
import { GithubPrStatusSection } from "./github-pr-status";

const BASE: GithubPrStatus = {
  state: "open",
  is_draft: true,
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
      <GithubPrStatusSection status={BASE} isLoading={false} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("GitHub PR");
    expect(text).toContain("Open");
    expect(text).toContain("Draft");
    expect(text).toContain("Changes requested");
    expect(text).toContain("Failing");
    expect(text).toContain("Conflicts");
    // Two counts, each labeled — a reader can't confuse conversation comments with reviews.
    expect(text).toContain("3 comments");
    expect(text).toContain("2 reviews");
    expect(text).toContain("synced");
  });

  it("shows Merged for a GitHub-merged PR and hides the checks/mergeable rows when unknown/none (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection
        status={{
          ...BASE,
          state: "merged",
          merged: true,
          is_draft: false,
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
    expect(text).not.toContain("Draft");
    // none checks / unknown mergeable rows are omitted to keep the panel compact.
    expect(text).not.toContain("Checks");
    expect(text).not.toContain("Mergeable");
  });

  it("renders a loading state while fetching (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection status={undefined} isLoading={true} />,
    );
    expect(container.textContent ?? "").toContain("Loading GitHub status…");
  });

  it("renders a fetch-failed state when there is no status to show (#850)", () => {
    const { container } = render(
      <GithubPrStatusSection status={undefined} isLoading={false} />,
    );
    expect(container.textContent ?? "").toContain(
      "Failed to load GitHub status.",
    );
  });

  it("keeps showing the last-loaded status during a failed background refetch (#850)", () => {
    // React Query keeps `data` on a failed refetch; isLoading is false with data present. The panel
    // must stay on the data branch, not flip to the error box.
    const { container } = render(
      <GithubPrStatusSection status={BASE} isLoading={false} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Open");
    expect(text).not.toContain("Failed to load GitHub status.");
  });
});
