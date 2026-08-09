// The detail screens fetch once through the aggregate page-data query and read every
// section from disabled per-section hooks (#2261). If the aggregate seeds a key the
// section hook does not read, that section silently renders empty — how Files changed
// disappeared in #2272. These tests pin the seeded keys to the hooks that read them.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import {
  useAcceptanceCriteria,
  useIssue,
  useIssueComments,
  useIssueDetailPage,
} from "./issues";
import {
  useDiffFeedback,
  usePull,
  usePullComments,
  usePullDetailPage,
  usePullFiles,
  usePullReviews,
} from "./pulls";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderWithClient<T>(hook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

describe("usePullDetailPage", () => {
  it("seeds every disabled PR section hook from the single page fetch", async () => {
    const page = {
      pull: { number: 7, title: "Aggregate PR" },
      files: [{ path: "core/db.ts", status: "modified" }],
      reviews: [{ id: 11, state: "PASS" }],
      line_comments: [{ id: 22, path: "core/db.ts" }],
      comments: [{ id: 33, body: "looks good" }],
      diff_feedback: {
        comment_counts: { "core/db.ts": 3 },
        orphaned_threads: [{ id: 44, pr_number: 7 }],
      },
    };
    vi.stubGlobal("fetch", mockRpcFetch({ "pageData/pullDetail": () => page }));

    const { result } = renderWithClient(() => ({
      page: usePullDetailPage("me", "proj", 7),
      pull: usePull("me", "proj", 7, false),
      files: usePullFiles("me", "proj", 7, false),
      reviews: usePullReviews("me", "proj", 7, false),
      lineComments: usePullComments("me", "proj", 7, false),
      comments: useIssueComments("me", "proj", 7, false),
      // The previous-threads list on the PR detail screen reads this scope (#123).
      orphanedFeedback: useDiffFeedback(
        "me",
        "proj",
        7,
        { orphaned: true },
        false,
      ),
    }));

    await waitFor(() => expect(result.current.page.isSuccess).toBe(true));
    await waitFor(() => {
      expect(result.current.files.data).toEqual(page.files);
    });
    expect(result.current.pull.data).toEqual(page.pull);
    expect(result.current.reviews.data).toEqual(page.reviews);
    expect(result.current.lineComments.data).toEqual(page.line_comments);
    expect(result.current.comments.data).toEqual(page.comments);
    expect(result.current.orphanedFeedback.data).toEqual({
      threads: page.diff_feedback.orphaned_threads,
      comment_counts: page.diff_feedback.comment_counts,
    });
  });
});

describe("useIssueDetailPage", () => {
  it("seeds every disabled issue section hook from the single page fetch", async () => {
    const page = {
      issue: { number: 5, title: "Aggregate issue" },
      comments: [{ id: 44, body: "first" }],
      acceptance_criteria: [{ id: "5-1", number: 1, text: "criterion" }],
    };
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({ "pageData/issueDetail": () => page }),
    );

    const { result } = renderWithClient(() => ({
      page: useIssueDetailPage("me", "proj", 5),
      issue: useIssue("me", "proj", 5, false),
      comments: useIssueComments("me", "proj", 5, false),
      criteria: useAcceptanceCriteria("me", "proj", 5, false),
    }));

    await waitFor(() => expect(result.current.page.isSuccess).toBe(true));
    await waitFor(() => {
      expect(result.current.comments.data).toEqual(page.comments);
    });
    expect(result.current.issue.data).toEqual(page.issue);
    expect(result.current.criteria.data).toEqual(page.acceptance_criteria);
  });
});
