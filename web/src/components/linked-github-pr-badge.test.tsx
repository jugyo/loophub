import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GithubPull } from "@/api/types";
import { LinkedGithubPrBadge } from "@/components/linked-github-pr-badge";

function makeGithubPull(overrides: Partial<GithubPull> = {}): GithubPull {
  return {
    number: 99,
    url: "https://github.com/me/proj/pull/99",
    branch: null,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    github_merged: false,
    github_merged_at: null,
    pushed_sha: null,
    ...overrides,
  };
}

describe("LinkedGithubPrBadge", () => {
  it("renders nothing when the PR has not been exported to GitHub", () => {
    const { container } = render(<LinkedGithubPrBadge github_pull={null} />);

    expect(container.textContent).toBe("");
  });

  it("shows the plain GH #N pill while the GitHub PR is not merged", () => {
    render(<LinkedGithubPrBadge github_pull={makeGithubPull()} />);

    const badge = screen.getByTitle("GitHub PR #99");
    expect(badge.textContent).toBe("GH #99");
    expect(badge.getAttribute("href")).toBe(
      "https://github.com/me/proj/pull/99",
    );
    expect(badge.className).toContain("text-muted-foreground");
  });

  it("says merged in the merged tone once the GitHub PR is merged", () => {
    render(
      <LinkedGithubPrBadge
        github_pull={makeGithubPull({
          github_merged: true,
          github_merged_at: "2026-07-15T00:00:00Z",
        })}
      />,
    );

    const badge = screen.getByTitle("GitHub PR #99 (merged)");
    expect(badge.textContent).toBe("GH #99 merged");
    expect(badge.getAttribute("href")).toBe(
      "https://github.com/me/proj/pull/99",
    );
    expect(badge.className).toContain("text-purple-500");
  });
});
