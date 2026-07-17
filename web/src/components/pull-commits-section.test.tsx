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
import type { PullFile, PullRequest } from "@/api/types";

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
  showGithubPushState = false,
  handlers = {},
}: {
  commits?: PullRequest["commits"];
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
        showGithubPushState={showGithubPushState}
      />
    </QueryClientProvider>,
  );
}

describe("PullCommitsSection", () => {
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
