import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type {
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
} from "@/api/types";

import { PullCommitsSection } from "./pull-commits-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const commits: PullRequest["commits"] = [
  {
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    author: "Alice",
    date: "2026-06-18T12:00:00Z",
    subject: "Latest change",
  },
  {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    author: "Bob",
    date: "2026-06-17T12:00:00Z",
    subject: "Earlier change",
  },
];

const files: PullFile[] = [
  {
    filename: "web/src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-const x = 0;\n+const x = 1;",
  },
];

function renderSection({
  commits: sectionCommits = commits,
  reviews = [],
  lineComments = [],
  isReviewsLoading = false,
  isReviewsError = false,
  showGithubPushState = false,
  handlers = {},
}: {
  commits?: PullRequest["commits"];
  reviews?: PullReview[];
  lineComments?: PullLineComment[];
  isReviewsLoading?: boolean;
  isReviewsError?: boolean;
  showGithubPushState?: boolean;
  handlers?: Record<string, (params: any) => unknown>;
} = {}) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({ "pulls/commitFiles": () => files, ...handlers }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PullCommitsSection
        owner="me"
        repo="proj"
        number={30}
        commits={sectionCommits}
        reviews={reviews}
        lineComments={lineComments}
        isReviewsLoading={isReviewsLoading}
        isReviewsError={isReviewsError}
        showGithubPushState={showGithubPushState}
      />
    </QueryClientProvider>,
  );
}

describe("PullCommitsSection", () => {
  it("opens review details from a compact status while keeping unreviewed commits simple", async () => {
    const reviews: PullReview[] = [
      {
        id: 1,
        user: { login: "quality-bot" },
        state: "PASS",
        body: "**Looks good.** [Details](https://example.com)",
        head_sha: commits![0].sha,
        model: "claude-opus-4-8",
        submitted_at: "2026-06-18T12:30:00Z",
        ac_results: [],
      },
    ];
    const lineComments: PullLineComment[] = [
      {
        id: 10,
        pull_request_review_id: 1,
        user: { login: "quality-bot" },
        path: "web/src/a.ts",
        line: 4,
        side: "RIGHT",
        body: "Keep this guard.",
        created_at: "2026-06-18T12:31:00Z",
      },
    ];

    renderSection({ reviews, lineComments });

    const reviewedCommit = screen
      .getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
      .closest("li")!;
    expect(reviewedCommit.dataset.debugComponent).toBe("PullCommitRow");
    const reviewStatus = within(reviewedCommit).getByRole("button", {
      name: "View 1 review for aaaaaaa: Latest change",
    });
    expect(within(reviewStatus).getByText("Reviewed")).toBeTruthy();
    expect(within(reviewStatus).getByText("passed")).toBeTruthy();
    expect(within(reviewStatus).getByText("1 review")).toBeTruthy();
    expect(within(reviewStatus).getByText("1 comment")).toBeTruthy();
    expect(within(reviewedCommit).queryByText("Looks good.")).toBeNull();

    reviewStatus.focus();
    fireEvent.click(reviewStatus);

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    const closeButton = within(reviewDialog).getByRole("button", {
      name: "Close reviews",
    });
    const detailsLink = within(reviewDialog).getByRole("link", {
      name: "Details",
    });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Tab" });
    expect(document.activeElement).toBe(detailsLink);
    fireEvent.keyDown(detailsLink, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(detailsLink);
    expect(reviewDialog.dataset.debugComponent).toBe("ReviewDetailsDialog");
    expect(
      reviewDialog.querySelector('[data-debug-component="ReviewItem"]'),
    ).toBeTruthy();
    expect(within(reviewDialog).getByText(/PASS/)).toBeTruthy();
    expect(within(reviewDialog).getByText("@quality-bot")).toBeTruthy();
    expect(within(reviewDialog).getByText("claude-opus-4-8")).toBeTruthy();
    expect(within(reviewDialog).getByText("Looks good.")).toBeTruthy();
    expect(within(reviewDialog).getByText("web/src/a.ts:4")).toBeTruthy();
    expect(within(reviewDialog).getByText("Keep this guard.")).toBeTruthy();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(reviewStatus);

    const unreviewedCommit = screen
      .getByRole("button", {
        name: "View changes in bbbbbbb: Earlier change",
      })
      .closest("li")!;
    expect(within(unreviewedCommit).getByText("Not reviewed")).toBeTruthy();
    expect(
      within(unreviewedCommit).queryByRole("button", {
        name: /View .* review/,
      }),
    ).toBeNull();
    expect(within(unreviewedCommit).queryByText("Looks good.")).toBeNull();
  });

  // Rubric grades (#1897) belong to the review that recorded them: counted on the commit row,
  // listed criterion by criterion in the review dialog.
  it("counts rubric grades on the commit row and lists them in the review dialog", async () => {
    const reviews: PullReview[] = [
      {
        id: 6,
        user: { login: "verifier #7-1" },
        state: "REQUEST_CHANGES",
        body: "One criterion unmet.",
        head_sha: commits![0].sha,
        model: "claude-opus-5",
        submitted_at: "2026-06-18T12:30:00Z",
        ac_results: [
          {
            criterion_id: 11,
            number: 1,
            text: "AC is shown read-only",
            verdict: "pass",
            note: "checklist renders without controls",
          },
          {
            criterion_id: 12,
            number: 2,
            text: "grades join to the AC text",
            verdict: "fail",
            note: "note is missing on one grade",
          },
          {
            criterion_id: 13,
            number: 3,
            text: "no own freshness",
            verdict: "pass",
            note: "",
          },
        ],
      },
    ];

    renderSection({ reviews });

    const reviewStatus = screen.getByRole("button", {
      name: "View 1 review for aaaaaaa: Latest change",
    });
    expect(
      within(reviewStatus)
        .getByLabelText("2 criteria passed, 1 failed")
        .textContent?.trim(),
    ).toBe("2 1");

    fireEvent.click(reviewStatus);
    const dialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    expect(within(dialog).getByText("AC 1")).toBeTruthy();
    expect(within(dialog).getByText("AC 2")).toBeTruthy();
    expect(within(dialog).getByText("AC 3")).toBeTruthy();
    expect(within(dialog).getByText("AC is shown read-only")).toBeTruthy();
    expect(
      within(dialog).getByText("checklist renders without controls"),
    ).toBeTruthy();
    expect(within(dialog).getByText("grades join to the AC text")).toBeTruthy();
    expect(
      within(dialog).getByText("note is missing on one grade"),
    ).toBeTruthy();
    expect(within(dialog).getAllByLabelText("pass")).toHaveLength(2);
    expect(within(dialog).getByLabelText("fail")).toBeTruthy();
    expect(within(dialog).queryByText(/No AC grading/)).toBeNull();
  });

  // The holistic fallback (design §7): the linked issue has no structured AC, so the review graded
  // none. Say so instead of showing an empty checklist, and leave the row uncounted.
  it("says there is no AC grading for a review that graded no criteria", async () => {
    const reviews: PullReview[] = [
      {
        id: 7,
        user: { login: "verifier #7-1" },
        state: "PASS",
        body: "Looks good.",
        head_sha: commits![0].sha,
        model: null,
        submitted_at: "2026-06-18T12:30:00Z",
        ac_results: [],
      },
    ];

    renderSection({ reviews });

    const reviewStatus = screen.getByRole("button", {
      name: "View 1 review for aaaaaaa: Latest change",
    });
    expect(within(reviewStatus).queryByLabelText(/criteria passed/)).toBeNull();

    fireEvent.click(reviewStatus);
    const dialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    expect(within(dialog).getByText(/No AC grading/)).toBeTruthy();
  });

  it("omits null and out-of-range reviews while keeping known commit reviews", async () => {
    const reviews: PullReview[] = [
      {
        id: 1,
        user: { login: "quality-bot" },
        state: "PASS",
        body: "Known review",
        head_sha: commits![0].sha,
        model: null,
        submitted_at: "2026-06-18T12:30:00Z",
        ac_results: [],
      },
      {
        id: 2,
        user: { login: "legacy-bot" },
        state: "COMMENT",
        body: "Legacy review",
        head_sha: null,
        model: null,
        submitted_at: "2026-06-16T10:00:00Z",
        ac_results: [],
      },
      {
        id: 3,
        user: { login: "security-bot" },
        state: "REQUEST_CHANGES",
        body: "Review for a commit outside this diff",
        head_sha: "cccccccccccccccccccccccccccccccccccccccc",
        model: null,
        submitted_at: "2026-06-17T10:00:00Z",
        ac_results: [],
      },
    ];

    renderSection({ reviews });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View 1 review for aaaaaaa: Latest change",
      }),
    );
    const knownDialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    expect(within(knownDialog).getByText("Known review")).toBeTruthy();
    expect(screen.queryByText("Reviews for unknown commits")).toBeNull();
    expect(screen.queryByText("unknown commit")).toBeNull();
    expect(screen.queryByText("ccccccc")).toBeNull();
    expect(screen.queryByText("Legacy review")).toBeNull();
    expect(
      screen.queryByText("Review for a commit outside this diff"),
    ).toBeNull();
  });

  it("computes each commit verdict from the latest substantive review", async () => {
    const reviews: PullReview[] = [
      {
        id: 4,
        user: { login: "quality-bot" },
        state: "REQUEST_CHANGES",
        body: "Round 1",
        head_sha: commits![0].sha,
        model: null,
        submitted_at: "2026-06-18T10:00:00Z",
        ac_results: [],
      },
      {
        id: 5,
        user: { login: "quality-bot" },
        state: "PASS",
        body: "Round 2",
        head_sha: commits![0].sha,
        model: null,
        submitted_at: "2026-06-18T11:00:00Z",
        ac_results: [],
      },
    ];

    renderSection({ reviews });

    const reviewedCommit = screen
      .getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      })
      .closest("li")!;
    expect(within(reviewedCommit).getByText("passed")).toBeTruthy();
    expect(within(reviewedCommit).queryByText("changes requested")).toBeNull();
    expect(within(reviewedCommit).queryByText("Round 1")).toBeNull();

    fireEvent.click(
      within(reviewedCommit).getByRole("button", {
        name: "View 2 reviews for aaaaaaa: Latest change",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Reviews for aaaaaaa: Latest change",
    });
    expect(within(dialog).getByText("Round 1")).toBeTruthy();
    expect(within(dialog).getByText("Round 2")).toBeTruthy();
  });

  it("keeps commits visible while reporting review loading and failures", () => {
    const { rerender } = renderSection({ isReviewsLoading: true });

    expect(screen.getByText("Loading reviews…")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("No reviews.")).toBeNull();

    rerender(
      <PullCommitsSection
        owner="me"
        repo="proj"
        number={30}
        commits={commits}
        reviews={[]}
        lineComments={[]}
        isReviewsLoading={false}
        isReviewsError={true}
        showGithubPushState={false}
      />,
    );

    expect(screen.getByText("Failed to load reviews.")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("No reviews.")).toBeNull();
  });

  it("renders commit metadata newest first", () => {
    renderSection();

    const section = screen
      .getByRole("heading", { name: "Commits (2)" })
      .closest("section")!;
    const rows = within(section).getAllByRole("listitem");

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("aaaaaaa");
    expect(rows[0].textContent).toContain("Latest change");
    expect(rows[0].textContent).toContain("Alice");
    expect(rows[1].textContent).toContain("bbbbbbb");
    expect(rows[1].textContent).toContain("Earlier change");
    expect(rows[1].textContent).toContain("Bob");
    expect(
      within(rows[0])
        .getByText(/ago|just now/)
        .closest("time")?.dateTime,
    ).toBe("2026-06-18T12:00:00Z");
  });

  it("marks only confirmed pushed commits when push state is shown", () => {
    renderSection({
      commits: [
        { ...commits![0], pushed_to_github: false },
        { ...commits![1], pushed_to_github: true },
      ],
      showGithubPushState: true,
    });

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).queryByText("Pushed")).toBeNull();
    expect(within(rows[1]).getByText("Pushed")).toBeTruthy();
  });

  // Commits are newest first, so only the topmost pushed row is labeled: the ones below it are
  // pushed too, and repeating the badge there says nothing new (#2039).
  it("marks only the latest pushed commit when several commits are pushed", () => {
    renderSection({
      commits: [
        { ...commits![0], pushed_to_github: false },
        { ...commits![1], pushed_to_github: true },
        {
          sha: "cccccccccccccccccccccccccccccccccccccccc",
          author: "Carol",
          date: "2026-06-16T12:00:00Z",
          subject: "Oldest change",
          pushed_to_github: true,
        },
      ],
      showGithubPushState: true,
    });

    const rows = screen.getAllByRole("listitem");
    expect(screen.getAllByText("Pushed")).toHaveLength(1);
    expect(within(rows[0]).queryByText("Pushed")).toBeNull();
    expect(within(rows[1]).getByText("Pushed")).toBeTruthy();
    expect(within(rows[2]).queryByText("Pushed")).toBeNull();
  });

  it("shows no push badge when nothing is pushed yet", () => {
    renderSection({
      commits: commits!.map((commit) => ({
        ...commit,
        pushed_to_github: false,
      })),
      showGithubPushState: true,
    });

    expect(screen.queryByText("Pushed")).toBeNull();
  });

  it("does not show GitHub push state when the PR has no linked GitHub PR", () => {
    renderSection({
      commits: commits!.map((commit) => ({
        ...commit,
        pushed_to_github: true,
      })),
      showGithubPushState: false,
    });

    expect(screen.queryByText("Pushed")).toBeNull();
  });

  it("opens a commit diff, closes it, and switches to another commit", async () => {
    const earlierFiles: PullFile[] = [
      {
        filename: "web/src/earlier.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+export const earlier = true;",
      },
    ];
    renderSection({
      handlers: {
        "pulls/commitFiles": (params) =>
          params.sha === commits![0].sha ? files : earlierFiles,
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    );

    const latestDialog = await screen.findByRole("dialog", {
      name: "Changes in aaaaaaa: Latest change",
    });
    expect(within(latestDialog).getByText("aaaaaaa")).toBeTruthy();
    expect(within(latestDialog).getByText("Latest change")).toBeTruthy();
    expect(await within(latestDialog).findByText("+const x = 1;")).toBeTruthy();
    expect(rpcCall("pulls/commitFiles")?.params).toEqual({
      repo: "me/proj",
      number: 30,
      sha: commits![0].sha,
    });

    fireEvent.click(
      within(latestDialog).getByRole("button", { name: "Close commit diff" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(
      screen.getByRole("button", {
        name: "View changes in bbbbbbb: Earlier change",
      }),
    );
    const earlierDialog = await screen.findByRole("dialog", {
      name: "Changes in bbbbbbb: Earlier change",
    });
    expect(
      await within(earlierDialog).findByText("+export const earlier = true;"),
    ).toBeTruthy();
    expect(within(earlierDialog).queryByText("+const x = 1;")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("distinguishes loading and empty commit diffs", async () => {
    let resolveFiles: (files: PullFile[]) => void = () => {};
    const pending = new Promise<PullFile[]>((resolve) => {
      resolveFiles = resolve;
    });
    renderSection({ handlers: { "pulls/commitFiles": () => pending } });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Changes in aaaaaaa: Latest change",
    });
    expect(within(dialog).getByText("Loading commit diff…")).toBeTruthy();

    resolveFiles([]);
    expect(
      await within(dialog).findByText("No changes in this commit."),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Loading commit diff…")).toBeNull();
  });

  it("shows commit diff retrieval failures in the dialog", async () => {
    renderSection({
      handlers: {
        "pulls/commitFiles": () => {
          throw new RpcFault(500, "simulated commit diff failure");
        },
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "View changes in aaaaaaa: Latest change",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Changes in aaaaaaa: Latest change",
    });
    expect(
      await within(dialog).findByText(/Failed to load commit diff/),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/simulated commit diff failure/),
    ).toBeTruthy();
  });

  it("renders an empty state when the PR has no commits", () => {
    renderSection({ commits: [] });

    const section = screen
      .getByRole("heading", { name: "Commits (0)" })
      .closest("section")!;

    expect(within(section).getByText("No commits.")).toBeTruthy();
    expect(within(section).queryAllByRole("listitem")).toHaveLength(0);
  });
});
