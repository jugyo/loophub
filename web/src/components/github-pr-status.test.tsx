import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type {
  GithubCheckRun,
  GithubConversation,
  GithubConversationThread,
  GithubPrStatus,
  GithubPull,
  PullRequest,
} from "@/api/types";
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

/** The loophub PR the section belongs to; its head is what the push action offers to push. */
const LOOPHUB_PULL: PullRequest = {
  number: 7,
  state: "open",
  title: "Export to GitHub",
  body: "",
  user: { login: "impl-bot" },
  head: { ref: "feature/x", sha: "head-sha" },
  base: { ref: "main", sha: "base-sha" },
  base_sha: "base-sha",
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  merge_commit_sha: null,
  additions: 1,
  deletions: 1,
  changed_files: 1,
  working: false,
  review_state: "PASSED",
  review_gate: {
    reviewed: true,
    passed: true,
    head_sha: "head-sha",
    blocking_reason: null,
    passed_scope: "full",
  },
  changes_addressed_at: null,
  changes_addressed_by: null,
  labels: [],
  comments: 0,
  created_at: "2026-06-18T11:00:00Z",
  updated_at: "2026-06-18T12:00:00Z",
  linked_issue: null,
  worktree_path: null,
  cost_stopped: false,
  merge_mode: "github_pr",
  github_pull: PULL,
  github_pr_export_started_at: null,
};

/** The fixture PR with its GitHub link overridden — the section reads the link off the PR. */
function withGithubPull(overrides: Partial<GithubPull>): PullRequest {
  return { ...LOOPHUB_PULL, github_pull: { ...PULL, ...overrides } };
}

const BASE: GithubPrStatus = {
  state: "open",
  merged: false,
  mergeable: "conflicting",
  review_decision: "changes_requested",
  checks: "failure",
  comments: 3,
  reviews: 2,
  unpushed_commits: 0,
  unpulled_commits: 0,
  updated_at: "2026-07-01T00:00:00Z",
  synced_at: "2026-07-01T00:00:30Z",
  is_draft: false,
  reviewers: [],
  check_runs: [],
};

const FAILED_CHECK: GithubCheckRun = {
  job_id: 77,
  name: "test",
  workflow: "CI",
  state: "failure",
  required: true,
  started_at: "2026-07-01T00:00:00Z",
  completed_at: "2026-07-01T00:01:30Z",
  url: "https://github.com/me/proj/actions/runs/1/job/77",
};

const THREAD: GithubConversationThread = {
  id: 900,
  path: "src/a.ts",
  line: 12,
  resolved: false,
  node_id: "T_1",
  comments: [
    {
      id: 900,
      author: "reviewer",
      body: "Please fix #123",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      url: "https://github.com/me/proj/pull/42#discussion_r900",
    },
  ],
};

const CONVERSATION: GithubConversation = {
  unresolved_threads: 1,
  entries: [
    {
      kind: "review",
      id: 50,
      author: "lead",
      body: "",
      created_at: "2026-07-02T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
      url: null,
      state: "approved",
      threads: [THREAD],
    },
    {
      kind: "comment",
      id: 51,
      author: "octocat",
      body: "Conversation text",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
      url: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The section owns the unlink and push mutations, so every render needs a query client. `handlers`
 * overrides the RPC stubs, which answer successfully by default.
 */
function renderSection(
  props: Partial<Parameters<typeof GithubPrStatusSection>[0]> = {},
  handlers: Record<string, (params: any) => unknown> = {},
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "pulls/unlinkGithubPull": () => ({ unlinked: true, github_number: 42 }),
      "pulls/pushGithubPull": () => ({ ...PULL, pushed_sha: "head-sha" }),
      "pulls/githubConversation": () => CONVERSATION,
      ...handlers,
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubPrStatusSection
        owner="me"
        repo="proj"
        pull={LOOPHUB_PULL}
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
    const { container, getByRole } = renderSection();
    const text = container.textContent ?? "";
    expect(text).toContain("GitHub PR");
    expect(text).toContain("Open");
    expect(text).toContain("Changes requested");
    expect(text).toContain("Failing");
    expect(text).toContain("Conflicts");
    // Two counts, each labeled — a reader can't confuse conversation comments with reviews.
    expect(text).toContain("3 comments");
    expect(text).toContain("2 reviews");
    expect(getByRole("group", { name: "Unpushed commits: 0" })).toBeTruthy();
    expect(getByRole("group", { name: "Unpulled commits: 0" })).toBeTruthy();
    expect(text).toContain("synced");
  });

  it("shows the local and remote commit counts separately", () => {
    const { getByRole } = renderSection({
      status: { ...BASE, unpushed_commits: 2, unpulled_commits: 3 },
    });
    expect(getByRole("group", { name: "Unpushed commits: 2" })).toBeTruthy();
    expect(getByRole("group", { name: "Unpulled commits: 3" })).toBeTruthy();
  });

  it("links to the GitHub PR from the section body in a new tab, showing its URL path (#2091)", () => {
    const { getByRole, getByText } = renderSection();

    // The heading is plain text; the link lives in the body.
    expect(getByRole("heading", { name: "GitHub PR" }).textContent).toBe(
      "GitHub PR",
    );
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
      pull: withGithubPull({ url: "gh.example.com/me/proj/pull/42" }),
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

  function openMenu(getByRole: ReturnType<typeof render>["getByRole"]) {
    fireEvent.pointerDown(getByRole("button", { name: /GitHub PR actions/i }), {
      button: 0,
      ctrlKey: false,
    });
  }

  it("disables Push to GitHub when the current head is already pushed (#2516)", async () => {
    const { getByRole, findByRole } = renderSection({
      pull: withGithubPull({ pushed_sha: LOOPHUB_PULL.head.sha }),
    });

    openMenu(getByRole);
    const item = await findByRole("menuitem", { name: /^Push to GitHub/i });
    expect(item.hasAttribute("data-disabled")).toBe(true);
    expect(item.title).toBe("No local changes to push to GitHub");
    fireEvent.click(item);
    expect(rpcCall("pulls/pushGithubPull")).toBeFalsy();
  });

  it.each([
    ["nothing is known to have been pushed", { pushed_sha: null }],
    ["there is no branch to push onto", { branch: "", pushed_sha: "old" }],
  ])("disables Push to GitHub when %s (#2516)", async (_label, overrides) => {
    const { getByRole, findByRole } = renderSection({
      pull: withGithubPull(overrides),
    });
    openMenu(getByRole);
    expect(
      (await findByRole("menuitem", { name: /^Push to GitHub/i })).hasAttribute(
        "data-disabled",
      ),
    ).toBe(true);
  });

  it("pushes an unpushed head from the menu (#2516)", async () => {
    const { getByRole, findByRole } = renderSection({
      pull: withGithubPull({ pushed_sha: "old-head" }),
    });

    openMenu(getByRole);
    fireEvent.click(await findByRole("menuitem", { name: /^Push to GitHub/i }));
    await waitFor(() => {
      expect(rpcCall("pulls/pushGithubPull")?.params).toMatchObject({
        repo: "me/proj",
        number: 7,
        force: false,
      });
    });
  });

  it("force-pushes when Force push is chosen from the menu (#1861)", async () => {
    const { getByRole, findByRole } = renderSection({
      pull: withGithubPull({ pushed_sha: "old-head" }),
    });

    openMenu(getByRole);
    fireEvent.click(
      await findByRole("menuitem", { name: /Force push to GitHub/i }),
    );

    await waitFor(() => {
      expect(rpcCall("pulls/pushGithubPull")?.params).toMatchObject({
        repo: "me/proj",
        number: 7,
        force: true,
      });
    });
  });

  it.each([
    ["loading", { status: undefined, isLoading: true }],
    ["failed to load", { status: undefined, isLoading: false }],
  ])("keeps the menu reachable while the status is %s (#2516)", (_label, statusProps) => {
    const { getByRole } = renderSection({
      pull: withGithubPull({ pushed_sha: "old-head" }),
      ...statusProps,
    });
    expect(getByRole("button", { name: /GitHub PR actions/i })).toBeTruthy();
  });

  it("says when the first sync has not happened yet", () => {
    const { getByText } = renderSection({ status: null });
    expect(getByText(/No GitHub status has been synced/)).toBeTruthy();
  });

  it("shows the merge blockers without an approval count", async () => {
    const { getByText, findByText, container } = renderSection({
      status: {
        ...BASE,
        is_draft: true,
        reviewers: [
          { login: "alice", state: "changes_requested" },
          { login: "bob", state: "pending" },
        ],
        check_runs: [FAILED_CHECK],
      },
    });
    expect(getByText("Draft")).toBeTruthy();
    expect(getByText("alice")).toBeTruthy();
    expect(getByText("bob")).toBeTruthy();
    expect(getByText("Required checks")).toBeTruthy();
    expect(getByText("1 failing")).toBeTruthy();
    expect(getByText("Conflicts")).toBeTruthy();
    expect(await findByText("Unresolved threads")).toBeTruthy();
    expect(container.textContent ?? "").not.toMatch(/approvals?\b/i);
  });

  it("lists each check with its state, Required and duration, and opens a failed log", async () => {
    const { getByText, findByText, getByRole } = renderSection(
      { status: { ...BASE, check_runs: [FAILED_CHECK] } },
      {
        "pulls/githubCheckLog": () => ({
          excerpt: "boom at line 3",
          fetched_at: "2026-07-01T00:00:00Z",
        }),
      },
    );
    expect(getByText("CI / test")).toBeTruthy();
    expect(getByText("Failed")).toBeTruthy();
    expect(getByText("Required")).toBeTruthy();
    expect(getByText("1m 30s")).toBeTruthy();
    expect(rpcCall("pulls/githubCheckLog")).toBeFalsy();
    fireEvent.click(getByRole("button", { name: "Show log" }));
    expect(await findByText("boom at line 3")).toBeTruthy();
  });

  it("re-runs a failed check", async () => {
    const { getByRole, findByText } = renderSection(
      { status: { ...BASE, check_runs: [FAILED_CHECK] } },
      { "pulls/rerunGithubCheck": () => ({ rerun: true }) },
    );
    fireEvent.click(getByRole("button", { name: "Re-run" }));
    expect(await findByText("Re-run requested")).toBeTruthy();
    expect(rpcCall("pulls/rerunGithubCheck")!.params).toMatchObject({
      job_id: 77,
    });
  });

  it("renders the conversation with threads under their review, and #123 as plain text", async () => {
    const { findByText, getByText, container } = renderSection();
    const thread = await findByText("src/a.ts:12");
    expect(getByText("Unresolved")).toBeTruthy();
    expect(getByText("Conversation text")).toBeTruthy();
    // Newest first: the review (with its thread) comes before the older comment.
    const text = container.textContent ?? "";
    expect(text.indexOf("src/a.ts:12")).toBeLessThan(
      text.indexOf("Conversation text"),
    );
    expect(
      thread.closest("[data-debug-component='GithubThread']"),
    ).toBeTruthy();
    expect(container.querySelector("a[href*='/123']")).toBeNull();
    expect(text).toContain("#123");
  });

  it("posts a comment, replies and resolves on GitHub, reporting nothing broken", async () => {
    const { findByRole, getByLabelText, getByRole, findByLabelText } =
      renderSection(
        {},
        {
          "pulls/commentOnGithubPull": () => ({ posted: true }),
          "pulls/replyToGithubThread": () => ({ posted: true }),
          "pulls/resolveGithubThread": () => ({ resolved: true }),
        },
      );
    fireEvent.change(await findByLabelText("Comment on GitHub"), {
      target: { value: "hello" },
    });
    fireEvent.click(getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(rpcCall("pulls/commentOnGithubPull")?.params).toMatchObject({
        body: "hello",
      }),
    );

    fireEvent.click(await findByRole("button", { name: "Reply" }));
    fireEvent.change(getByLabelText("Reply on GitHub"), {
      target: { value: "ok" },
    });
    fireEvent.submit(getByLabelText("Reply on GitHub").closest("form")!);
    await waitFor(() =>
      expect(rpcCall("pulls/replyToGithubThread")?.params).toMatchObject({
        thread_id: 900,
        body: "ok",
      }),
    );

    fireEvent.click(getByRole("button", { name: /Resolve/ }));
    await waitFor(() =>
      expect(rpcCall("pulls/resolveGithubThread")?.params).toMatchObject({
        thread_id: 900,
      }),
    );
  });

  it("marks a Draft ready and merges with a chosen method", async () => {
    const { getByRole, findByRole } = renderSection(
      { status: { ...BASE, is_draft: true } },
      { "pulls/markGithubPullReady": () => ({ ready: true }) },
    );
    fireEvent.click(getByRole("button", { name: "Ready for review" }));
    await waitFor(() =>
      expect(rpcCall("pulls/markGithubPullReady")).toBeTruthy(),
    );
    cleanup();

    const merged = renderSection(
      {},
      { "pulls/mergeGithubPull": () => ({ merged: true }) },
    );
    fireEvent.pointerDown(merged.getByRole("button", { name: /^Merge/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await findByRole("menuitem", { name: "Squash and merge" }));
    await waitFor(() =>
      expect(rpcCall("pulls/mergeGithubPull")?.params).toMatchObject({
        method: "squash",
      }),
    );
  });

  it("sends the selected thread and check to a running agent", async () => {
    const { findByLabelText, getByLabelText, getByRole } = renderSection(
      {
        agentRunning: true,
        status: { ...BASE, check_runs: [FAILED_CHECK] },
      },
      { "pulls/requestGithubFixes": () => ({ id: 1 }) },
    );
    fireEvent.click(await findByLabelText(/Select src\/a.ts:12/));
    fireEvent.click(getByLabelText(/Select CI \/ test/));
    fireEvent.click(getByRole("button", { name: /Ask agent to fix \(2\)/ }));
    await waitFor(() =>
      expect(rpcCall("pulls/requestGithubFixes")?.params).toMatchObject({
        thread_ids: [900],
        job_ids: [77],
      }),
    );
  });

  it("disables asking the agent and says why when none is running", async () => {
    const { findByLabelText, findByRole, getByText } = renderSection({
      status: { ...BASE, check_runs: [FAILED_CHECK] },
    });
    expect(
      ((await findByLabelText(/Select src\/a.ts:12/)) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        (await findByRole("button", {
          name: /Ask agent to fix/,
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(getByText(/No agent is running on this PR/)).toBeTruthy();
  });

  it.each([
    ["closed", { state: "closed" as const }, "closed"],
    ["merged", { merged: true }, "merged"],
  ])("is read-only on a %s PR and says the data is the last sync", async (_label, overrides, word) => {
    const { queryByRole, queryByLabelText, findByText, getByText } =
      renderSection({
        pull: { ...withGithubPull({ pushed_sha: "old-head" }), ...overrides },
        status: { ...BASE, is_draft: true, check_runs: [FAILED_CHECK] },
      });
    await findByText("src/a.ts:12");
    expect(getByText(new RegExp(`This PR is ${word}`))).toBeTruthy();
    expect(queryByRole("button", { name: /GitHub PR actions/i })).toBeNull();
    expect(queryByLabelText("Comment on GitHub")).toBeNull();
    expect(queryByRole("button", { name: "Reply" })).toBeNull();
    expect(queryByRole("button", { name: /Resolve/ })).toBeNull();
    expect(queryByRole("button", { name: "Re-run" })).toBeNull();
    expect(queryByRole("button", { name: /Ready for review/ })).toBeNull();
    expect(queryByRole("button", { name: /^Merge/ })).toBeNull();
    expect(queryByRole("button", { name: /Ask agent/ })).toBeNull();
  });

  it("confirms before unlinking, saying the GitHub PR itself is untouched (#2384)", async () => {
    const { getByRole, findByRole } = renderSection();

    openMenu(getByRole);
    fireEvent.click(
      await findByRole("menuitem", { name: /Unlink GitHub PR/i }),
    );
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
    openMenu(getByRole);
    fireEvent.click(
      await findByRole("menuitem", { name: /Unlink GitHub PR/i }),
    );
    await findByRole("dialog");
    fireEvent.click(getByRole("button", { name: /Cancel/i }));
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(rpcCall("pulls/unlinkGithubPull")).toBeFalsy();

    // Confirming sends the unlink for this PR.
    openMenu(getByRole);
    fireEvent.click(
      await findByRole("menuitem", { name: /Unlink GitHub PR/i }),
    );
    await findByRole("dialog");
    fireEvent.click(getByRole("button", { name: /^Unlink$/ }));
    await waitFor(() => expect(rpcCall("pulls/unlinkGithubPull")).toBeTruthy());
    expect(rpcCall("pulls/unlinkGithubPull")!.params).toMatchObject({
      repo: "me/proj",
      number: 7,
    });
  });

  it("keeps the dialog open and shows the failure when the unlink fails (#2384)", async () => {
    const { getByRole, findByRole } = renderSection(
      {},
      {
        "pulls/unlinkGithubPull": () => {
          throw new RpcFault(409, "PR #7 has no GitHub PR to unlink");
        },
      },
    );

    openMenu(getByRole);
    fireEvent.click(
      await findByRole("menuitem", { name: /Unlink GitHub PR/i }),
    );
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
