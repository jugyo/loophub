import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
import type { DiffFeedbackThread, PullFile } from "@/api/types";

import { DiffFeedbackHistory, DiffFileDialog } from "./pull-diff-dialog";

const { showError } = vi.hoisted(() => ({ showError: vi.fn() }));

vi.mock("@/components/toast", () => ({
  useToast: () => ({ showError }),
}));

const typesetCss = readFileSync(resolve("src/typeset.css"), "utf8");

afterEach(() => {
  cleanup();
  showError.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file: PullFile = {
  filename: "web/src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-const x = 0;\n+const x = 1;",
};

function stableDiff() {
  return {
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: [
      {
        path: file.filename,
        original_path: null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
        lines: [
          {
            kind: "hunk",
            text: "@@ -1 +1 @@",
            left_line: null,
            right_line: null,
          },
          {
            kind: "deletion",
            text: "-const x = 0;",
            left_line: 1,
            right_line: null,
          },
          {
            kind: "addition",
            text: "+const x = 1;",
            left_line: null,
            right_line: 1,
          },
        ],
      },
    ],
  };
}

function feedbackThread(
  patch: Partial<DiffFeedbackThread> = {},
): DiffFeedbackThread {
  const anchor = {
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    path: "web/src/a.ts",
    original_path: null,
    side: "RIGHT" as const,
    start_line: 1,
    end_line: 2,
    ...patch.anchor,
  };
  const freshness = patch.freshness ?? "current";
  return {
    id: 1,
    pr_number: 30,
    created_by: "reviewer",
    created_by_type: "agent",
    created_at: "2026-07-28T00:00:00Z",
    messages: [
      {
        id: 11,
        thread_id: 1,
        author: "reviewer",
        author_type: "agent",
        body: "Please revisit this range.",
        created_at: "2026-07-28T00:00:00Z",
        reactions: [],
      },
    ],
    archived_at: null,
    ...patch,
    anchor,
    resolved_anchor:
      patch.resolved_anchor === undefined
        ? freshness === "current"
          ? {
              path: anchor.path,
              original_path: anchor.original_path,
              side: anchor.side,
              start_line: anchor.start_line,
              end_line: anchor.end_line,
            }
          : null
        : patch.resolved_anchor,
    freshness,
    placement:
      patch.placement ?? (freshness === "current" ? "inline" : "historical"),
    outdated_reason:
      patch.outdated_reason === undefined
        ? freshness === "outdated"
          ? "modified"
          : null
        : patch.outdated_reason,
    original_context: patch.original_context ?? null,
  };
}

function renderDialog({
  file: dialogFile = file,
  files,
  onSelectFile = () => {},
  onClose = () => {},
  handlers = {},
}: {
  file?: PullFile;
  files?: PullFile[];
  onSelectFile?: (filename: string) => void;
  onClose?: () => void;
  handlers?: Record<string, (params: any) => unknown>;
} = {}) {
  vi.stubGlobal("fetch", mockRpcFetch(handlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DiffFileDialog
        owner="me"
        repo="proj"
        number={30}
        files={files ?? [dialogFile]}
        file={dialogFile}
        onSelectFile={onSelectFile}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

// The hover + button comments on one line; pressing a line number cell and moving over further
// cells drags a range. The + button only exists once the diff query has reported which lines are
// commentable, so both helpers wait for it before acting on a cell labelled like "New line 1".
function addCommentButton(label: string) {
  return screen.findByRole("button", {
    name: `Comment on ${label.toLowerCase()}`,
  });
}

async function addComment(label: string) {
  fireEvent.click(await addCommentButton(label));
}

async function dragLines(from: string, ...through: string[]) {
  await addCommentButton(from);
  fireEvent.pointerDown(screen.getByLabelText(from), { button: 0 });
  for (const label of through) {
    fireEvent.pointerEnter(screen.getByLabelText(label));
  }
  fireEvent.pointerUp(document);
}

describe("DiffFileDialog", () => {
  it("posts a copied-file comment with a target-side anchor", async () => {
    const create = vi.fn(() => ({
      thread: feedbackThread({
        anchor: {
          ...feedbackThread().anchor,
          path: "copy.txt",
          original_path: "source.txt",
          start_line: 1,
          end_line: 1,
        },
      }),
      comment: {},
    }));
    const copiedFile: PullFile = {
      filename: "source.txt => copy.txt",
      previousFilename: "source.txt",
      headFilename: "copy.txt",
      status: "copied",
      additions: 0,
      deletions: 0,
      patch:
        "similarity index 100%\ncopy from source.txt\ncopy to copy.txt\n@@ -0,0 +1,2 @@\n+one\n+two",
    };
    renderDialog({
      file: copiedFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "copy.txt",
              original_path: "source.txt",
              status: "copied",
              additions: 0,
              deletions: 0,
              patch: copiedFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -0,0 +1,2 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+one",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "addition",
                  text: "+two",
                  left_line: null,
                  right_line: 2,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({ threads: [] }),
        "diffFeedback/create": create,
      },
    });

    expect(screen.queryByText("No textual diff.")).toBeNull();
    const commentButtons = await screen.findAllByRole("button", {
      name: "Comment on new line 1",
    });
    expect(commentButtons).toHaveLength(1);
    expect(
      screen.getAllByRole("button", {
        name: "Comment on new line 2",
      }),
    ).toHaveLength(1);
    fireEvent.click(commentButtons[0]);
    const composer = screen.getByLabelText("Diff comment");
    fireEvent.change(composer, {
      target: { value: "Copied line" },
    });
    fireEvent.click(
      within(composer.closest("tr") as HTMLElement).getByRole("button", {
        name: "Comment",
      }),
    );
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "copy.txt",
          side: "RIGHT",
          start_line: 1,
          end_line: 1,
          body: "Copied line",
        }),
      ),
    );
  });

  it("renders the diff", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    expect(dialog.getAttribute("data-debug-component")).toBe("DiffFileDialog");
    expect(dialog.classList).toContain("w-full");
    expect(dialog.className).not.toContain("max-w-");
    expect(dialog.parentElement?.hasAttribute("data-debug-component")).toBe(
      false,
    );
    expect(within(dialog).getByText("const x = 1;")).toBeTruthy();
    expect(within(dialog).getByLabelText("Old line 1")).toBeTruthy();
    expect(within(dialog).getByLabelText("New line 1")).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows consistent diff feedback metadata without obscuring the comment body", async () => {
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                start_line: 1,
                end_line: 1,
              },
              messages: [
                {
                  ...feedbackThread().messages[0],
                  id: 123,
                  author: "reviewer-with-a-long-desktop-username",
                },
              ],
            }),
          ],
        }),
      },
    });

    const thread = await screen.findByLabelText("Diff thread 1");
    const author = within(thread).getByText(
      "@reviewer-with-a-long-desktop-username",
    );
    const time = thread.querySelector("time")!;
    const id = within(thread).getByLabelText("Comment ID 123");

    expect(time.getAttribute("datetime")).toBe("2026-07-28T00:00:00Z");
    expect(id.textContent).toBe("#123");
    expect(id.classList).toContain("ml-auto");
    expect(
      author.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      time.compareDocumentPosition(id) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(thread).getByText("Please revisit this range.")).toBeTruthy();
  });

  it("starts in unified view and switches to split view", () => {
    const splitFile: PullFile = {
      ...file,
      additions: 2,
      patch:
        "@@ -1,2 +1,3 @@\n-const x = 0;\n+const x = 1;\n+const y = 2;\n keep",
    };
    const { container } = renderDialog({ file: splitFile });

    expect(
      screen
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const unifiedLine = screen.getByText("const x = 1;").closest("td");
    expect(unifiedLine?.classList).toContain("whitespace-pre-wrap");
    expect(unifiedLine?.classList).toContain("break-words");
    const unifiedTable = unifiedLine?.closest("table");
    expect(unifiedTable?.classList).toContain("table-fixed");
    expect(unifiedTable?.querySelectorAll("colgroup col")).toHaveLength(3);
    expect(unifiedTable?.parentElement?.classList).not.toContain(
      "overflow-x-auto",
    );

    fireEvent.click(screen.getByRole("button", { name: "Split" }));

    expect(
      screen
        .getByRole("button", { name: "Split" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const before = screen.getByText("const x = 0;").closest("td");
    const after = screen.getByText("const x = 1;").closest("td");
    expect(before?.parentElement).toBe(after?.parentElement);
    expect(
      within(before?.parentElement as HTMLElement).getByLabelText("Old line 1"),
    ).toBeTruthy();
    expect(
      within(after?.parentElement as HTMLElement).getByLabelText("New line 1"),
    ).toBeTruthy();
    expect(screen.getByText("const y = 2;")).toBeTruthy();
    const contentColumns = container.querySelectorAll("colgroup col[style]");
    expect(contentColumns).toHaveLength(2);
    expect((contentColumns[0] as HTMLElement).style.width).toBe(
      "calc(50% - 3rem)",
    );
    const splitLine = screen.getByText("const x = 1;").closest("div");
    expect(splitLine?.classList).toContain("whitespace-pre-wrap");
    expect(splitLine?.classList).toContain("break-words");
    expect(splitLine?.classList).not.toContain("overflow-x-auto");
    expect(
      container.querySelectorAll('[data-line-kind="context"]'),
    ).toHaveLength(2);
  });

  it("keeps line numbers on the first line of wrapped rows in both views", () => {
    renderDialog();

    const unifiedNumber = screen.getByLabelText("Old line 1");
    expect(unifiedNumber.classList).toContain("align-top");
    expect(screen.getByText("const x = 1;").closest("td")?.classList).toContain(
      "align-top",
    );

    fireEvent.click(screen.getByRole("button", { name: "Split" }));

    const splitNumber = screen.getByLabelText("Old line 1");
    expect(splitNumber.classList).toContain("align-top");
    expect(splitNumber.nextElementSibling?.classList).toContain("align-top");
  });

  it("ignores whitespace-only changes in unified and split views, then restores them", async () => {
    const fullPatch =
      "@@ -1,3 +1,3 @@\n-const first = 1;\n+  const first = 1;\n-const second = 2;\n+const second = 3;\n keep";
    const ignoredPatch =
      "@@ -2,2 +2,2 @@\n-const second = 2;\n+const second = 3;\n keep";
    const diff = vi.fn((params: { ignore_whitespace?: boolean }) => ({
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      files: [
        {
          path: file.filename,
          absolute_path: "/repo/web/src/a.ts",
          original_path: null,
          status: "modified",
          additions: 2,
          deletions: 2,
          patch: params.ignore_whitespace ? ignoredPatch : fullPatch,
          lines: [],
        },
      ],
    }));
    renderDialog({
      file: { ...file, additions: 2, deletions: 2, patch: fullPatch },
      handlers: { "pulls/diff": diff },
    });

    await waitFor(() => expect(diff).toHaveBeenCalled());
    expect(screen.getAllByText("const first = 1;")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Ignore whitespace" }));

    await waitFor(() =>
      expect(
        diff.mock.calls.some(([params]) => params.ignore_whitespace === true),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText("const first = 1;")).toBeNull(),
    );
    expect(screen.getByText("const second = 2;")).toBeTruthy();
    expect(screen.getByText("const second = 3;")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.queryByText("const first = 1;")).toBeNull();
    expect(screen.getByText("const second = 3;")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ignore whitespace" }));
    await waitFor(() =>
      expect(screen.getAllByText("const first = 1;")).toHaveLength(2),
    );
  });

  it("shows no textual diff when the selected file only changes whitespace", async () => {
    const whitespacePatch =
      "@@ -1 +1 @@\n-const value = 1;\n+  const value = 1;";
    renderDialog({
      file: { ...file, patch: whitespacePatch },
      handlers: {
        "pulls/diff": (params: { ignore_whitespace?: boolean }) => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: params.ignore_whitespace
            ? []
            : [
                {
                  path: file.filename,
                  absolute_path: "/repo/web/src/a.ts",
                  original_path: null,
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  patch: whitespacePatch,
                  lines: [],
                },
              ],
        }),
      },
    });

    expect(screen.getAllByText("const value = 1;")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Ignore whitespace" }));
    expect(await screen.findByText("No textual diff.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ignore whitespace" }));
    expect(screen.getAllByText("const value = 1;")).toHaveLength(2);
  });

  it("keeps a range selection and its thread across unified and split views", async () => {
    const create = vi.fn(() => ({
      thread: {
        id: 9,
        pr_number: 30,
        anchor: {
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          path: "web/src/a.ts",
          original_path: null,
          side: "RIGHT",
          start_line: 1,
          end_line: 2,
        },
        freshness: "current",
        created_by: "me",
        created_by_type: "human",
        created_at: "2026-07-28T00:00:00Z",
        messages: [],
      },
      comment: {},
    }));
    renderDialog({
      file: {
        ...file,
        additions: 2,
        patch: "@@ -1 +1,2 @@\n-old\n+new one\n+new two",
      },
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 1,
              patch: "@@ -1 +1,2 @@\n-old\n+new one\n+new two",
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1,2 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-old",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+new one",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "addition",
                  text: "+new two",
                  left_line: null,
                  right_line: 2,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({ threads: [] }),
        "diffFeedback/create": create,
      },
    });

    await dragLines("New line 1", "New line 2");
    expect(screen.getByText("RIGHT 1–2")).toBeTruthy();
    const unifiedComposerRow = screen
      .getByLabelText("Diff comment")
      .closest("tr");
    expect(unifiedComposerRow?.hasAttribute("data-diff-comment-row")).toBe(
      true,
    );
    expect(unifiedComposerRow?.children).toHaveLength(1);
    expect(unifiedComposerRow?.previousElementSibling?.textContent).toContain(
      "new two",
    );
    const unifiedComposerCell = screen
      .getByLabelText("Diff comment")
      .closest("td");
    expect(unifiedComposerCell?.firstElementChild?.classList).toContain(
      "sticky",
    );
    expect(unifiedComposerCell?.firstElementChild?.classList).toContain(
      "left-0",
    );
    expect(unifiedComposerCell?.firstElementChild?.classList).toContain(
      "w-[100cqw]",
    );
    expect(
      unifiedComposerRow?.closest("table")?.parentElement?.classList,
    ).toContain("[container-type:inline-size]");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Diff comment")).toBeNull();

    await dragLines("New line 1", "New line 2");

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByText("RIGHT 1–2")).toBeTruthy();
    const splitComposerRow = screen
      .getByLabelText("Diff comment")
      .closest("tr");
    expect(splitComposerRow?.hasAttribute("data-diff-comment-row")).toBe(true);
    expect(splitComposerRow?.children).toHaveLength(2);
    expect(splitComposerRow?.previousElementSibling?.textContent).toContain(
      "new two",
    );

    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Please keep these together" },
    });
    fireEvent.keyDown(screen.getByLabelText("Diff comment"), { key: "Enter" });
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          side: "RIGHT",
          start_line: 1,
          end_line: 2,
          body: "Please keep these together",
        }),
      ),
    );
  });

  it("posts a non-empty diff comment once with Cmd+Enter", async () => {
    let resolveCreate!: () => void;
    let serverThreads: DiffFeedbackThread[] = [];
    const pending = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    const create = vi.fn(async () => {
      await pending;
      const thread = feedbackThread({
        id: 9,
        created_by: "me",
        created_by_type: "human",
        anchor: {
          ...feedbackThread().anchor,
          start_line: 1,
          end_line: 1,
        },
        messages: [
          {
            id: 19,
            thread_id: 9,
            author: "me",
            author_type: "human",
            body: "Keyboard feedback",
            created_at: "2026-07-28T00:01:00Z",
            reactions: [],
          },
        ],
      });
      serverThreads = [thread];
      return { thread, comment: thread.messages[0] };
    });
    const listFeedback = vi.fn(() => ({ threads: serverThreads }));
    renderDialog({
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: file.filename,
              original_path: null,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch: file.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-const x = 0;",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const x = 1;",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": listFeedback,
        "diffFeedback/create": create,
      },
    });

    await addComment("New line 1");
    const textarea = screen.getByLabelText("Diff comment");

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "Keyboard feedback" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Keyboard feedback" }),
    );
    // #2456: posted as the supervising human, not as an unregistered browser session.
    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ session_id: expect.anything() }),
    );
    expect(screen.getAllByText("Keyboard feedback")).toHaveLength(1);
    expect(screen.queryByLabelText("Diff comment")).toBeNull();

    resolveCreate();
    await waitFor(() => {
      expect(listFeedback).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("Diff thread 9")).toBeTruthy();
      expect(screen.getAllByText("Keyboard feedback")).toHaveLength(1);
    });
  });

  it("shows an optimistic diff comment while the initial feedback list is pending", async () => {
    const feedbackPending = new Promise<never>(() => {});
    const createPending = new Promise<never>(() => {});
    renderDialog({
      handlers: {
        "pulls/diff": stableDiff,
        "diffFeedback/list": () => feedbackPending,
        "diffFeedback/create": () => createPending,
      },
    });

    await addComment("New line 1");
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Visible before feedback loads." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(
      await screen.findByText("Visible before feedback loads."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Diff comment")).toBeNull();
  });

  it("removes an optimistic diff comment when posting fails during the initial feedback load", async () => {
    const feedbackPending = new Promise<never>(() => {});
    const listFeedback = vi.fn(() => feedbackPending);
    let rejectCreate!: (error: RpcFault) => void;
    const createPending = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });
    renderDialog({
      handlers: {
        "pulls/diff": stableDiff,
        "diffFeedback/list": listFeedback,
        "diffFeedback/create": () => createPending,
      },
    });

    await addComment("New line 1");
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Remove this failed comment." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Remove this failed comment.")).toBeTruthy();

    rejectCreate(new RpcFault(500, "write failed"));
    await waitFor(() => {
      expect(screen.queryByLabelText(/^Diff thread -/)).toBeNull();
      expect(
        (screen.getByLabelText("Diff comment") as HTMLTextAreaElement).value,
      ).toBe("Remove this failed comment.");
      expect(showError).toHaveBeenCalledWith("Create failed: write failed");
      expect(listFeedback).toHaveBeenCalledTimes(2);
    });
  });

  it("restores the diff composer and thread cache when posting fails", async () => {
    let rejectCreate!: (error: RpcFault) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });
    renderDialog({
      handlers: {
        "pulls/diff": stableDiff,
        "diffFeedback/list": () => ({ threads: [] }),
        "diffFeedback/create": () => pending,
      },
    });

    await addComment("New line 1");
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Please retry this range." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Please retry this range.")).toBeTruthy();
    expect(screen.queryByLabelText("Diff comment")).toBeNull();

    rejectCreate(new RpcFault(500, "write failed"));
    await waitFor(() => {
      expect(screen.queryByLabelText(/^Diff thread -/)).toBeNull();
      expect(
        (screen.getByLabelText("Diff comment") as HTMLTextAreaElement).value,
      ).toBe("Please retry this range.");
      expect(showError).toHaveBeenCalledWith("Create failed: write failed");
    });
  });

  it("starts the composer empty after a cancelled draft", async () => {
    renderDialog({
      handlers: {
        "pulls/diff": stableDiff,
        "diffFeedback/list": () => ({ threads: [] }),
      },
    });

    // Cancelling drops the draft, so the next comment starts on an empty composer instead of the
    // abandoned text.
    await addComment("New line 1");
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Abandoned draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Diff comment")).toBeNull();

    await addComment("New line 1");
    expect(
      (screen.getByLabelText("Diff comment") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("posts a non-empty thread reply once with Cmd+Enter", async () => {
    const initialThread = feedbackThread();
    let thread = feedbackThread({
      anchor: { ...initialThread.anchor, end_line: 1 },
    });
    const reply = vi.fn((params: { body: string }) => {
      thread = {
        ...thread,
        messages: [
          ...thread.messages,
          {
            id: 12,
            thread_id: thread.id,
            author: "me",
            author_type: "human",
            body: params.body,
            created_at: "2026-07-30T00:00:00Z",
            reactions: [],
          },
        ],
      };
      return { thread, reply: thread.messages.at(-1) };
    });
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({ threads: [thread] }),
        "diffFeedback/reply": reply,
      },
    });

    const textarea = await screen.findByLabelText("Reply to thread 1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(reply).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: " Keyboard reply " } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_id: 1,
        body: "Keyboard reply",
      }),
    );
    // #2456: posted as the supervising human, not as an unregistered browser session.
    expect(reply).toHaveBeenCalledWith(
      expect.not.objectContaining({ session_id: expect.anything() }),
    );
    expect(await screen.findByText("Keyboard reply")).toBeTruthy();
  });

  it("clears the selection and composer when navigating to another file", async () => {
    const secondFile = {
      ...file,
      filename: "web/src/b.ts",
    };
    const handlers = {
      "pulls/diff": (params: { path: string }) => ({
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        files: [
          {
            path: params.path,
            original_path: null,
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: file.patch,
            lines: [
              {
                kind: "hunk",
                text: "@@ -1 +1 @@",
                left_line: null,
                right_line: null,
              },
              {
                kind: "deletion",
                text: "-const x = 0;",
                left_line: 1,
                right_line: null,
              },
              {
                kind: "addition",
                text: "+const x = 1;",
                left_line: null,
                right_line: 1,
              },
            ],
          },
        ],
      }),
      "diffFeedback/list": () => ({ threads: [] }),
    };
    const view = renderDialog({ files: [file, secondFile], handlers });

    await addComment("New line 1");
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Comment for file A" },
    });

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DiffFileDialog
          owner="me"
          repo="proj"
          number={30}
          files={[file, secondFile]}
          file={secondFile}
          hasPreviousFile
          hasNextFile={false}
          onPreviousFile={() => {}}
          onNextFile={() => {}}
          onSelectFile={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    const secondFileLine = await screen.findByLabelText("New line 1");
    expect(secondFileLine.hasAttribute("data-selected")).toBe(false);
    expect(screen.queryByLabelText("Diff comment")).toBeNull();
    expect(screen.queryByText("Comment for file A")).toBeNull();
  });

  it("selects a LEFT deletion plus context range and resets at a hunk boundary", async () => {
    const patch =
      "@@ -1,3 +1,2 @@\n same\n-removed\n tail\n@@ -10 +9 @@\n-old hunk\n+new hunk";
    renderDialog({
      file: { ...file, patch },
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 2,
              patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,3 +1,2 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "context",
                  text: " same",
                  left_line: 1,
                  right_line: 1,
                },
                {
                  kind: "deletion",
                  text: "-removed",
                  left_line: 2,
                  right_line: null,
                },
                {
                  kind: "context",
                  text: " tail",
                  left_line: 3,
                  right_line: 2,
                },
                {
                  kind: "hunk",
                  text: "@@ -10 +9 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-old hunk",
                  left_line: 10,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+new hunk",
                  left_line: null,
                  right_line: 9,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({ threads: [] }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Split" }));

    await dragLines("Old line 1", "Old line 2");
    expect(screen.getByText("LEFT 1–2")).toBeTruthy();
    expect(screen.getByLabelText("Old line 2").dataset.selected).toBe("true");

    // A drag stops at the hunk boundary and never crosses to the other side.
    await dragLines("Old line 1", "Old line 10");
    expect(screen.getByText("LEFT 1")).toBeTruthy();
    await dragLines("Old line 1", "New line 1");
    expect(screen.getByText("LEFT 1")).toBeTruthy();
    expect(
      screen.getByLabelText("New line 1").dataset.selected,
    ).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    await addComment("New line 1");
    expect(screen.getByText("RIGHT 1")).toBeTruthy();
  });

  it("opens the composer from the + button shown on a hovered line number", async () => {
    renderDialog({
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: file.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-const x = 0;",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const x = 1;",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({ threads: [] }),
      },
    });

    const addButton = await screen.findByRole("button", {
      name: "Comment on new line 1",
    });
    // Hidden until its line number cell is hovered, and never rendered for a missing counterpart.
    expect(addButton.className).toContain("opacity-0");
    expect(addButton.className).toContain("group-hover:opacity-100");
    expect(
      within(screen.getByLabelText("New line 1")).getByRole("button", {
        name: "Comment on new line 1",
      }),
    ).toBe(addButton);

    // Opening the composer must not remount the rows above it, which would reset the diff's scroll
    // position the same way it did in the rendered view (#352).
    const lineCell = screen.getByLabelText("New line 1");
    fireEvent.click(addButton);
    expect(screen.getByText("RIGHT 1")).toBeTruthy();
    expect(screen.getByLabelText("Diff comment")).toBeTruthy();
    expect(screen.getByLabelText("New line 1")).toBe(lineCell);
  });

  it("comments on the line under the pointer when the two diffs disagree", async () => {
    // The dialog renders the patch it was handed but asks pulls/diff which lines take a comment.
    // The two are fetched separately and can describe different ranges — after the base branch
    // moves, for one — so the same array position means a different line in each.
    renderDialog({
      file: { ...file, patch: "@@ -10 +10 @@\n-const x = 0;\n+const x = 1;" },
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 2,
              patch: "",
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-const a = 0;",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const a = 1;",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "hunk",
                  text: "@@ -10 +10 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-const x = 0;",
                  left_line: 10,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const x = 1;",
                  left_line: null,
                  right_line: 10,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({ threads: [] }),
      },
    });

    await addComment("New line 10");

    expect(screen.getByText("RIGHT 10")).toBeTruthy();
  });

  it("renders and operates on one thread with the standard composer layout", async () => {
    const reply = vi.fn(() => ({}));
    const patch = "@@ -1 +1,2 @@\n-old\n+new one\n+new two";
    const view = renderDialog({
      file: { ...file, additions: 2, patch },
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 1,
              patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1,2 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-old",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+new one",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "addition",
                  text: "+new two",
                  left_line: null,
                  right_line: 2,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({ threads: [feedbackThread()] }),
        "diffFeedback/reply": reply,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Split" }));

    expect(await screen.findAllByLabelText("Diff thread 1")).toHaveLength(1);
    expect(
      view.container.querySelectorAll('[data-thread-anchor="true"]'),
    ).toHaveLength(2);
    expect(
      screen.getByLabelText("Old line 1").hasAttribute("data-thread-anchor"),
    ).toBe(false);

    await addComment("New line 1");
    const commentInput = screen.getByLabelText("Diff comment");
    const replyInput = screen.getByLabelText("Reply to thread 1");
    const commentActions = screen.getByRole("button", {
      name: "Comment",
    }).parentElement;
    const replyActions = screen.getByRole("button", {
      name: "Reply",
    }).parentElement;
    expect(commentInput.className).toContain("w-full");
    expect(replyInput.className).toContain("w-full");
    expect(commentActions?.className).toContain("mt-2 flex justify-end gap-2");
    expect(replyActions?.className).toContain("mt-2 flex justify-end gap-2");
    expect(commentActions?.previousElementSibling).toBe(commentInput);
    expect(replyActions?.previousElementSibling).toBe(replyInput);

    fireEvent.change(screen.getByLabelText("Reply to thread 1"), {
      target: { value: "Updated now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_id: 1,
          body: "Updated now",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(screen.getAllByLabelText("Diff thread 1")).toHaveLength(1);
    expect(
      view.container.querySelectorAll('[data-thread-anchor="true"]'),
    ).toHaveLength(2);
    expect(
      screen.getByLabelText("Old line 1").hasAttribute("data-thread-anchor"),
    ).toBe(false);
    const threadRow = screen
      .getByLabelText("Diff thread 1")
      .closest("tr")?.previousElementSibling;
    expect(within(threadRow as HTMLElement).getByText("new two")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reply to thread 1"), {
      target: { value: "Also checked unified" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
  });

  it("expands and shrinks diff comment composers with their content", async () => {
    renderDialog({
      handlers: {
        "pulls/diff": stableDiff,
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                side: "LEFT",
                start_line: 1,
                end_line: 1,
              },
            }),
          ],
        }),
      },
    });

    await addComment("New line 1");
    const commentComposer = screen.getByLabelText(
      "Diff comment",
    ) as HTMLTextAreaElement;
    const replyComposer = screen.getByLabelText(
      "Reply to thread 1",
    ) as HTMLTextAreaElement;
    let commentScrollHeight = 128;
    let replyScrollHeight = 112;
    Object.defineProperty(commentComposer, "scrollHeight", {
      configurable: true,
      get: () => commentScrollHeight,
    });
    Object.defineProperty(replyComposer, "scrollHeight", {
      configurable: true,
      get: () => replyScrollHeight,
    });

    fireEvent.change(commentComposer, {
      target: {
        value: "A diff comment that wraps onto several displayed lines.",
      },
    });
    fireEvent.change(replyComposer, {
      target: { value: "A reply that wraps onto several displayed lines." },
    });
    expect(commentComposer.style.height).toBe("128px");
    expect(replyComposer.style.height).toBe("112px");
    expect(commentComposer.className).toContain("resize-none");
    expect(replyComposer.className).toContain("overflow-hidden");

    commentScrollHeight = 64;
    replyScrollHeight = 56;
    fireEvent.change(commentComposer, { target: { value: "Short comment" } });
    fireEvent.change(replyComposer, { target: { value: "Short reply" } });
    expect(commentComposer.style.height).toBe("64px");
    expect(replyComposer.style.height).toBe("56px");
  });

  it("shows the author once for a single-message conversation", async () => {
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                start_line: 1,
                end_line: 1,
              },
            }),
          ],
        }),
      },
    });

    const card = await screen.findByLabelText("Diff thread 1");
    expect(within(card).getAllByText("@reviewer")).toHaveLength(1);
  });

  // #2129: a diff conversation stores only an author name, so the human actor names read as
  // @human while an agent session keeps its own name.
  it("shows a human diff conversation as @human and leaves an agent reply alone", async () => {
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              created_by: "unknown",
              created_by_type: "human",
              anchor: {
                ...feedbackThread().anchor,
                start_line: 1,
                end_line: 1,
              },
              messages: [
                {
                  id: 11,
                  thread_id: 1,
                  author: "unknown",
                  author_type: "human",
                  body: "Please rename this.",
                  created_at: "2026-07-28T00:00:00Z",
                  reactions: [],
                },
                {
                  id: 12,
                  thread_id: 1,
                  author: "executor #12-1",
                  author_type: "agent",
                  body: "Renamed.",
                  created_at: "2026-07-28T00:02:00Z",
                  reactions: [],
                },
              ],
            }),
          ],
        }),
      },
    });

    const card = await screen.findByLabelText("Diff thread 1");
    expect(within(card).getAllByText("@human")).toHaveLength(1);
    expect(within(card).getAllByText("@executor #12-1")).toHaveLength(1);
    expect(within(card).queryByText("@unknown")).toBeNull();
    expect(within(card).getAllByLabelText("AI agent")).toHaveLength(1);
  });

  it("renders a current thread at its resolved coordinates", async () => {
    const patch = "@@ -1 +1,2 @@\n-old\n+new one\n+new two";
    const view = renderDialog({
      file: { ...file, additions: 2, patch },
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                start_line: 1,
                end_line: 1,
              },
              resolved_anchor: {
                path: "web/src/a.ts",
                original_path: null,
                side: "RIGHT",
                start_line: 2,
                end_line: 2,
              },
            }),
          ],
        }),
      },
    });

    const card = await screen.findByLabelText("Diff thread 1");
    expect(within(card).queryByText("RIGHT 2")).toBeNull();
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Show diff anchor information for thread 1",
      }),
    );
    const anchorInfo = within(card).getByRole("dialog", {
      name: "Diff anchor information for thread 1",
    });
    expect(within(anchorInfo).getByText("Current")).toBeTruthy();
    expect(within(anchorInfo).getByText("web/src/a.ts")).toBeTruthy();
    expect(within(anchorInfo).getByText("RIGHT 2")).toBeTruthy();
    expect(
      screen.getByLabelText("New line 1").hasAttribute("data-thread-anchor"),
    ).toBe(false);
    expect(
      screen.getByLabelText("New line 2").hasAttribute("data-thread-anchor"),
    ).toBe(true);
    const threadRow = card.closest("tr")?.previousElementSibling;
    expect(within(threadRow as HTMLElement).getByText("new two")).toBeTruthy();
    expect(
      view.container.querySelectorAll('[data-thread-anchor="true"]'),
    ).toHaveLength(1);
  });

  it("places deletion threads on the left and other threads on the right in split view", async () => {
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                side: "LEFT",
                start_line: 1,
                end_line: 1,
              },
            }),
            feedbackThread({
              id: 2,
              anchor: {
                ...feedbackThread().anchor,
                side: "RIGHT",
                start_line: 1,
                end_line: 1,
              },
              messages: [
                {
                  id: 12,
                  thread_id: 2,
                  author: "reviewer",
                  author_type: "agent",
                  body: "Please check the replacement.",
                  created_at: "2026-07-28T00:01:00Z",
                  reactions: [],
                },
              ],
            }),
          ],
        }),
      },
    });

    await screen.findByLabelText("Diff thread 1");
    fireEvent.click(screen.getByRole("button", { name: "Split" }));

    const leftCell = screen
      .getByLabelText("Diff thread 1")
      .closest("td") as HTMLTableCellElement;
    const rightCell = screen
      .getByLabelText("Diff thread 2")
      .closest("td") as HTMLTableCellElement;

    expect(leftCell.cellIndex).toBe(0);
    expect(leftCell.colSpan).toBe(2);
    expect(rightCell.cellIndex).toBe(1);
    expect(rightCell.colSpan).toBe(2);
  });

  it("optimistically adds, changes, and removes a reaction", async () => {
    let serverReactions = [{ emoji: "👍", count: 2, reacted: false }];
    let resolveReact!: (
      message: ReturnType<typeof feedbackThread>["messages"][number],
    ) => void;
    const react = vi.fn(
      () =>
        new Promise<ReturnType<typeof feedbackThread>["messages"][number]>(
          (resolve) => {
            resolveReact = (message) => {
              serverReactions = message.reactions;
              resolve(message);
            };
          },
        ),
    );
    const listFeedback = vi.fn(() => ({
      threads: [
        feedbackThread({
          anchor: {
            ...feedbackThread().anchor,
            start_line: 1,
            end_line: 1,
          },
          messages: [
            {
              ...feedbackThread().messages[0],
              reactions: serverReactions,
            },
          ],
        }),
      ],
    }));
    renderDialog({
      handlers: {
        "diffFeedback/list": listFeedback,
        "diffFeedback/react": react,
      },
    });

    expect(await screen.findByLabelText("👍 reaction: 2")).toBeTruthy();
    fireEvent.pointerDown(screen.getByLabelText("Add reaction to comment 11"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "React with 🎉" }),
    );

    const added = await screen.findByLabelText("🎉 reaction: 1");
    expect(added.getAttribute("aria-pressed")).toBe("true");
    expect(react).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 11, emoji: "🎉" }),
    );
    resolveReact({
      ...feedbackThread().messages[0],
      reactions: [
        { emoji: "👍", count: 2, reacted: false },
        { emoji: "🎉", count: 1, reacted: true },
      ],
    });
    await waitFor(() =>
      expect(
        screen.getByLabelText("🎉 reaction: 1").getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    await waitFor(() => expect(listFeedback).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("👍 reaction: 2") as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    fireEvent.click(screen.getByLabelText("👍 reaction: 2"));
    await waitFor(() => {
      expect(screen.queryByLabelText("🎉 reaction: 1")).toBeNull();
      expect(
        screen.getByLabelText("👍 reaction: 3").getAttribute("aria-pressed"),
      ).toBe("true");
    });
    resolveReact({
      ...feedbackThread().messages[0],
      reactions: [{ emoji: "👍", count: 3, reacted: true }],
    });
    await waitFor(() => {
      expect(listFeedback).toHaveBeenCalledTimes(3);
      expect(screen.getByLabelText("👍 reaction: 3")).toBeTruthy();
      expect(
        (screen.getByLabelText("👍 reaction: 3") as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    fireEvent.click(screen.getByLabelText("👍 reaction: 3"));
    await waitFor(() =>
      expect(screen.getByLabelText("👍 reaction: 2")).toBeTruthy(),
    );
    resolveReact({
      ...feedbackThread().messages[0],
      reactions: [{ emoji: "👍", count: 2, reacted: false }],
    });
    await waitFor(() => {
      expect(listFeedback).toHaveBeenCalledTimes(4);
      expect(screen.getByLabelText("👍 reaction: 2")).toBeTruthy();
    });
  });

  it("rolls back an optimistic reaction and reports a failed request", async () => {
    let rejectReact!: (error: RpcFault) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectReact = reject;
    });
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                end_line: 1,
              },
            }),
          ],
        }),
        "diffFeedback/react": () => pending,
      },
    });

    await screen.findByLabelText("Add reaction to comment 11");
    fireEvent.pointerDown(screen.getByLabelText("Add reaction to comment 11"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "React with 🎉" }),
    );
    expect(await screen.findByLabelText("🎉 reaction: 1")).toBeTruthy();

    rejectReact(new RpcFault(500, "write failed"));
    await waitFor(() => {
      expect(screen.queryByLabelText("🎉 reaction: 1")).toBeNull();
      expect(showError).toHaveBeenCalledWith("Reaction failed: write failed");
    });
  });

  it("keeps a file-scoped historical conversation replyable", async () => {
    let serverThread = feedbackThread({
      freshness: "outdated",
      anchor: {
        ...feedbackThread().anchor,
        end_line: 1,
      },
    });
    let resolveReply!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveReply = resolve;
    });
    const listFeedback = vi.fn(() => ({ threads: [serverThread] }));
    const reply = vi.fn(async () => {
      await pending;
      const confirmedReply = {
        id: 12,
        thread_id: 1,
        author: "me",
        author_type: "human",
        body: "Still relevant",
        created_at: "2026-07-28T00:02:00Z",
        reactions: [],
      };
      serverThread = {
        ...serverThread,
        messages: [...serverThread.messages, confirmedReply],
      };
      return { thread: serverThread, reply: confirmedReply };
    });
    renderDialog({
      handlers: {
        "diffFeedback/list": listFeedback,
        "diffFeedback/reply": reply,
      },
    });

    const section = await screen.findByLabelText("Previous diff threads");
    fireEvent.click(
      within(section).getByRole("button", { name: "Previous diff threads" }),
    );
    const card = within(section).getByLabelText("Diff thread 1");
    expect(within(card).queryByText("Outdated")).toBeNull();
    expect(within(card).queryByText("RIGHT 1–2")).toBeNull();
    fireEvent.change(screen.getByLabelText("Reply to thread 1"), {
      target: { value: "Still relevant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => {
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ thread_id: 1, body: "Still relevant" }),
      );
      expect(screen.getAllByText("Still relevant")).toHaveLength(1);
    });

    resolveReply();
    await waitFor(() => {
      expect(listFeedback).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText("Still relevant")).toHaveLength(1);
    });
  });

  it("keeps a visible outdated conversation inline and replyable", async () => {
    const reply = vi.fn(() => ({}));
    const archive = vi.fn(() => ({}));
    renderDialog({
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: file.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-const x = 0;",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const x = 1;",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              freshness: "outdated",
              placement: "inline",
              anchor: {
                ...feedbackThread().anchor,
                end_line: 1,
              },
              original_context: [
                {
                  kind: "addition",
                  text: "+new one",
                  left_line: null,
                  right_line: 1,
                  anchored: true,
                },
              ],
            }),
          ],
        }),
        "diffFeedback/reply": reply,
        "diffFeedback/archive": archive,
      },
    });

    const card = await screen.findByLabelText("Diff thread 1");
    expect(within(card).queryByText("Outdated")).toBeNull();
    expect(
      within(card).queryByLabelText("Historical context for thread 1"),
    ).toBeNull();
    expect(screen.queryByLabelText("Previous diff threads")).toBeNull();
    const threadRow = screen
      .getByLabelText("Diff thread 1")
      .closest("tr")?.previousElementSibling;
    expect(
      within(threadRow as HTMLElement).getByText("const x = 1;"),
    ).toBeTruthy();
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Show diff anchor information for thread 1",
      }),
    );
    const anchorInfo = within(card).getByRole("dialog", {
      name: "Diff anchor information for thread 1",
    });
    expect(within(anchorInfo).getByText("Outdated")).toBeTruthy();
    expect(within(anchorInfo).getByText("Modified")).toBeTruthy();
    expect(within(anchorInfo).getByText("RIGHT 1")).toBeTruthy();
    expect(
      within(anchorInfo).getByLabelText("Historical context for thread 1")
        .textContent,
    ).toContain("> +new one");
    fireEvent.change(screen.getByLabelText("Reply to thread 1"), {
      target: { value: "Still relevant" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ thread_id: 1, body: "Still relevant" }),
      ),
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for diff thread 1" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith(
        expect.objectContaining({ thread_id: 1, archived: true }),
      ),
    );
  });

  it("copies a diff thread's markdown from its three dots menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                start_line: 1,
                end_line: 1,
              },
            }),
          ],
        }),
      },
    });

    fireEvent.pointerDown(
      await screen.findByRole("button", {
        name: "Actions for diff thread 1",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy as Markdown" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Please revisit this range."),
    );
  });

  it("collapses an archived conversation and expands it on demand", async () => {
    const archive = vi.fn(() => ({}));
    renderDialog({
      handlers: {
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              anchor: {
                ...feedbackThread().anchor,
                start_line: 1,
                end_line: 1,
              },
              archived_at: "2026-07-29T00:00:00Z",
            }),
          ],
        }),
        "diffFeedback/archive": archive,
      },
    });

    const card = await screen.findByLabelText("Diff thread 1");
    expect(
      within(card).getByLabelText("Archived diff thread 1").textContent,
    ).toContain("Please revisit this range.");
    expect(within(card).queryByLabelText("Reply to thread 1")).toBeNull();

    fireEvent.click(within(card).getByLabelText("Archived diff thread 1"));
    expect(within(card).getByLabelText("Reply to thread 1")).toBeTruthy();

    fireEvent.pointerDown(
      within(card).getByRole("button", {
        name: "Actions for diff thread 1",
      }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith(
        expect.objectContaining({ thread_id: 1, archived: false }),
      ),
    );
  });

  it("falls back to previous diff threads when the original range is hidden", async () => {
    renderDialog({
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "web/src/a.ts",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: file.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-const x = 0;",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+const x = 1;",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              freshness: "outdated",
              anchor: {
                ...feedbackThread().anchor,
                start_line: 8,
                end_line: 8,
              },
            }),
          ],
        }),
      },
    });

    const section = await screen.findByLabelText("Previous diff threads");
    const toggle = within(section).getByRole("button", {
      name: "Previous diff threads",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(section).queryByLabelText("Diff thread 1")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(section).getByLabelText("Diff thread 1")).toBeTruthy();
  });

  it("lets a long diff shrink inside the dialog and scroll vertically", () => {
    const longPatch = [
      "@@ -1,100 +1,100 @@",
      ...Array.from({ length: 100 }, (_, index) => ` line ${index + 1}`),
    ].join("\n");
    const { container } = renderDialog({
      file: { ...file, additions: 0, deletions: 0, patch: longPatch },
    });

    const content = container.querySelector(
      '[data-debug-component="FileDiffContent"]',
    );
    const scroller = content?.parentElement;
    const rightPane = scroller?.parentElement;
    expect(screen.getByText("line 100")).toBeTruthy();
    expect(scroller?.classList).toContain("overflow-auto");
    // Scroll anchoring would move this offset when a comment composer opens above the anchor it
    // picks; jsdom has no anchoring to exercise, so the opt-out is asserted as the class that
    // carries it (see .diff-scrollport in index.css).
    expect(scroller?.classList).toContain("diff-scrollport");
    expect(rightPane?.classList).toContain("min-h-0");
  });

  it("resets the diff scroll position only when the open file changes", () => {
    const secondFile = { ...file, filename: "web/src/b.ts" };
    const files = [file, secondFile];
    const showFile = (openFile: PullFile) => (
      <QueryClientProvider client={new QueryClient()}>
        <DiffFileDialog
          owner="me"
          repo="proj"
          number={30}
          files={files}
          file={openFile}
          onSelectFile={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>
    );
    const view = renderDialog({ file, files });
    const scroller = () =>
      (
        view.container.querySelector(
          '[data-debug-component="FileDiffContent"]',
        ) as HTMLElement
      ).parentElement as HTMLElement;

    const scrolled = scroller();
    scrolled.scrollTop = 400;
    scrolled.scrollLeft = 120;
    view.rerender(showFile(file));
    expect(scroller()).toBe(scrolled);
    expect(scrolled.scrollTop).toBe(400);
    expect(scrolled.scrollLeft).toBe(120);

    view.rerender(showFile(secondFile));
    expect(scroller().scrollTop).toBe(0);
    expect(scroller().scrollLeft).toBe(0);
  });

  it("keeps replacements paired when no-newline markers separate them", () => {
    renderDialog({
      file: {
        ...file,
        patch:
          "@@ -1 +1 @@\n-const value = 'before';\n\\ No newline at end of file\n+const value = 'after';\n\\ No newline at end of file",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Split" }));

    const before = screen.getByText("const value = 'before';").closest("td");
    const after = screen.getByText("const value = 'after';").closest("td");
    expect(before?.parentElement).toBe(after?.parentElement);
    expect(
      within(before as HTMLElement).getByText("\\ No newline at end of file"),
    ).toBeTruthy();
    expect(
      within(after as HTMLElement).getByText("\\ No newline at end of file"),
    ).toBeTruthy();
  });

  it("closes on Escape and on a backdrop click", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays open when a mouse action starts in the panel and ends on the backdrop", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when the panel itself is clicked", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    fireEvent.click(
      screen.getByRole("dialog", { name: /Diff for web\/src\/a\.ts/i }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not render previous or next file buttons", () => {
    renderDialog();

    expect(screen.queryByRole("button", { name: /Prev/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Next/i })).toBeNull();
  });

  it("lists changed files as a directory tree and selects a file from it", () => {
    const onSelectFile = vi.fn();
    const secondFile = {
      ...file,
      filename: "core/nested/b.ts",
      status: "added",
      additions: 4,
      deletions: 0,
    };
    renderDialog({ files: [file, secondFile], onSelectFile });

    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });
    const dialog = screen.getByRole("dialog");
    expect(sidebar.parentElement).toBe(dialog);
    expect(dialog.firstElementChild).toBe(sidebar);
    expect(within(sidebar).getByText("Files changed (2)")).toBeTruthy();
    expect(
      within(sidebar)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim())
        .filter((label) => label !== ""),
    ).toEqual(["web/src", "Ma.ts+1−1", "core/nested", "Ab.ts+4−0"]);
    expect(
      within(sidebar)
        .getByRole("button", { name: "web/src/a.ts" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      within(sidebar).getByLabelText("File status: modified"),
    ).toBeTruthy();
    expect(within(sidebar).getByText("+1")).toBeTruthy();
    expect(within(sidebar).getByText("−1")).toBeTruthy();
    expect(within(sidebar).getByLabelText("File status: added")).toBeTruthy();
    expect(within(sidebar).getByText("+4")).toBeTruthy();
    const secondRow = within(sidebar).getByRole("button", {
      name: "core/nested/b.ts",
    });
    expect(
      Array.from(secondRow.children).map((child) => child.textContent),
      // The trailing cell holds the viewed badge and the comment count together, so it is present
      // even when this row has neither (#2502).
    ).toEqual(["A", "b.ts", "+4−0", "", ""]);
    expect(secondRow.className).toContain("grid-cols-");
    const filename = within(secondRow).getByText("b.ts");
    expect(filename.className).toContain("min-w-0");
    expect(filename.className).toContain("truncate");

    fireEvent.click(secondRow);
    expect(onSelectFile).toHaveBeenCalledWith("core/nested/b.ts");
  });

  it("records the open file's current commit when Viewed is ticked", async () => {
    const set = vi.fn(() => []);
    renderDialog({
      file: { ...file, last_changed_sha: "c".repeat(40) },
      handlers: { "pullFileViews/set": set },
    });

    const checkbox = screen.getByRole("checkbox", { name: "Viewed" });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "web/src/a.ts",
          sha: "c".repeat(40),
          viewed: true,
        }),
      ),
    );
  });

  it("hides viewed files from the tree until they are asked for", async () => {
    const secondFile: PullFile = {
      ...file,
      filename: "core/b.ts",
      last_changed_sha: "b".repeat(40),
    };
    renderDialog({
      file,
      files: [file, secondFile],
      handlers: {
        "pullFileViews/list": () => [
          { path: "core/b.ts", sha: "b".repeat(40), viewed_at: "2026-08-20Z" },
        ],
      },
    });
    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });

    await waitFor(() =>
      expect(
        within(sidebar).queryByRole("button", { name: "core/b.ts" }),
      ).toBeNull(),
    );
    expect(within(sidebar).getByText("Files changed (1 of 2)")).toBeTruthy();

    expect(within(sidebar).getByText(/Show viewed \(1 viewed\)/)).toBeTruthy();
    fireEvent.click(
      within(sidebar).getByRole("switch", { name: "Show viewed" }),
    );
    const row = within(sidebar).getByRole("button", { name: "core/b.ts" });
    expect(within(row).getByLabelText("Viewed")).toBeTruthy();
    expect(within(sidebar).getByText(/Show viewed \(1 viewed\)/)).toBeTruthy();
  });

  it("leaves a file marked at an older commit listed, labelled and unticked", async () => {
    renderDialog({
      file: { ...file, last_changed_sha: "c".repeat(40) },
      handlers: {
        "pullFileViews/list": () => [
          {
            path: "web/src/a.ts",
            sha: "a".repeat(40),
            viewed_at: "2026-08-20Z",
          },
        ],
      },
    });
    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });

    await waitFor(() =>
      expect(
        within(sidebar).getAllByLabelText("Changed since viewed").length,
      ).toBe(1),
    );
    expect(within(sidebar).getByText("Files changed (1)")).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Viewed" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("indents nested rows and keeps the selected file's directories open", () => {
    const files = [
      file,
      { ...file, filename: "web/src/lib/b.ts" },
      { ...file, filename: "README.md" },
    ];
    renderDialog({ files });
    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });

    const rows = within(sidebar)
      .getAllByRole("listitem")
      .map((item) => item.firstElementChild as HTMLElement);
    expect(
      rows.map((row) => [row.textContent?.trim(), row.style.paddingLeft]),
    ).toEqual([
      ["web/src", "12px"],
      ["Ma.ts+1−1", "26px"],
      ["lib", "26px"],
      ["Mb.ts+1−1", "40px"],
      ["MREADME.md+1−1", "12px"],
    ]);
    expect(
      within(sidebar)
        .getByRole("button", { name: "web/src/a.ts" })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("collapses and expands a directory row", () => {
    const files = [file, { ...file, filename: "core/b.ts" }];
    renderDialog({ files });
    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });
    const directory = within(sidebar).getByRole("button", { name: "web/src" });
    expect(directory.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(directory);
    expect(directory.getAttribute("aria-expanded")).toBe("false");
    expect(within(sidebar).queryByLabelText("web/src/a.ts")).toBeNull();
    expect(within(sidebar).getByLabelText("core/b.ts")).toBeTruthy();
    expect(within(sidebar).getByText("Files changed (2)")).toBeTruthy();

    fireEvent.click(directory);
    expect(directory.getAttribute("aria-expanded")).toBe("true");
    expect(within(sidebar).getByLabelText("web/src/a.ts")).toBeTruthy();
  });

  it("resizes the changed files sidebar by dragging its boundary", () => {
    renderDialog();

    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });
    const separator = screen.getByRole("separator", {
      name: "Resize changed files sidebar",
    });
    expect((sidebar as HTMLElement).style.width).toBe("336px");

    fireEvent.pointerDown(separator, { button: 0, clientX: 336 });
    fireEvent.pointerMove(document, { clientX: 400 });
    expect((sidebar as HTMLElement).style.width).toBe("400px");
    expect(separator.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.pointerUp(document);
  });

  it("toggles and combines include and exclude glob filters", () => {
    const files = [
      file,
      { ...file, filename: "web/src/a.test.ts" },
      { ...file, filename: "core/b.ts" },
      { ...file, filename: "README.md" },
      { ...file, filename: "a.test.ts" },
    ];
    renderDialog({ files });
    const sidebar = screen.getByRole("complementary", {
      name: "Changed files",
    });

    expect(within(sidebar).queryByLabelText("Include files")).toBeNull();
    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Toggle file filters" }),
    );
    expect(within(sidebar).getByLabelText("Include files")).toBeTruthy();

    fireEvent.change(within(sidebar).getByLabelText("Include files"), {
      target: { value: "web/**" },
    });
    fireEvent.change(within(sidebar).getByLabelText("Exclude files"), {
      target: { value: "**/*.test.ts" },
    });

    expect(within(sidebar).getByText("Files changed (1 of 5)")).toBeTruthy();
    expect(within(sidebar).getByLabelText("web/src/a.ts")).toBeTruthy();
    expect(within(sidebar).queryByLabelText("web/src/a.test.ts")).toBeNull();
    expect(within(sidebar).queryByLabelText("a.test.ts")).toBeNull();
    expect(within(sidebar).queryByLabelText("core/b.ts")).toBeNull();

    fireEvent.change(within(sidebar).getByLabelText("Include files"), {
      target: { value: "" },
    });
    fireEvent.change(within(sidebar).getByLabelText("Exclude files"), {
      target: { value: "" },
    });
    expect(within(sidebar).getByText("Files changed (5)")).toBeTruthy();
    expect(within(sidebar).getByLabelText("README.md")).toBeTruthy();

    fireEvent.change(within(sidebar).getByLabelText("Include files"), {
      target: { value: "*.test.ts" },
    });
    expect(within(sidebar).getByText("Files changed (2 of 5)")).toBeTruthy();
    expect(within(sidebar).getByLabelText("web/src/a.test.ts")).toBeTruthy();
    expect(within(sidebar).getByLabelText("a.test.ts")).toBeTruthy();

    fireEvent.change(within(sidebar).getByLabelText("Include files"), {
      target: { value: "*b.ts" },
    });
    fireEvent.change(within(sidebar).getByLabelText("Exclude files"), {
      target: { value: "*test.ts" },
    });
    expect(within(sidebar).getByText("Files changed (1 of 5)")).toBeTruthy();
    expect(within(sidebar).getByLabelText("core/b.ts")).toBeTruthy();

    fireEvent.change(within(sidebar).getByLabelText("Include files"), {
      target: { value: "**/*.test.ts" },
    });
    fireEvent.change(within(sidebar).getByLabelText("Exclude files"), {
      target: { value: "" },
    });
    expect(within(sidebar).getByText("Files changed (2 of 5)")).toBeTruthy();

    fireEvent.click(
      within(sidebar).getByRole("button", { name: "Toggle file filters" }),
    );
    expect(within(sidebar).queryByLabelText("Include files")).toBeNull();
  });

  it("keeps the standard mode while navigating between files", () => {
    const view = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(
      screen.getByRole("button", { name: "Raw" }).getAttribute("aria-pressed"),
    ).toBe("true");

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DiffFileDialog
          owner="me"
          repo="proj"
          number={30}
          files={[{ ...file, filename: "web/src/b.ts" }]}
          file={{ ...file, filename: "web/src/b.ts" }}
          onSelectFile={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Raw" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("copies the displayed file path with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const dialog = renderDialog().container;

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Copy file path: web/src/a.ts",
      }),
    );

    expect(writeText).toHaveBeenCalledWith("web/src/a.ts");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Copied" }),
      ).toBeTruthy(),
    );
  });

  it.each([
    {
      name: "added file at the head commit",
      file: {
        filename: "src/new file.ts",
        status: "added",
        additions: 2,
        deletions: 0,
        patch: "",
      } satisfies PullFile,
      stablePath: "src/new file.ts",
      originalPath: null,
    },
    {
      name: "modified file at the head commit",
      file: {
        filename: "src/app.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        patch: "",
      } satisfies PullFile,
      stablePath: "src/app.ts",
      originalPath: null,
    },
    {
      name: "removed file at the base commit",
      file: {
        filename: "src/old.ts",
        status: "removed",
        additions: 0,
        deletions: 4,
        patch: "",
      } satisfies PullFile,
      stablePath: "src/old.ts",
      originalPath: null,
    },
    {
      name: "renamed file at both commits",
      file: {
        filename: "src/old.ts => src/new.ts",
        previousFilename: "src/old.ts",
        headFilename: "src/new.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "",
      } satisfies PullFile,
      stablePath: "src/new.ts",
      originalPath: "src/old.ts",
    },
  ])("shows file information without git commands for a $name", async (testCase) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderDialog({
      file: testCase.file,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: testCase.stablePath,
              absolute_path: `/repos/project/${testCase.stablePath}`,
              original_path: testCase.originalPath,
              status: testCase.file.status,
              additions: testCase.file.additions,
              deletions: testCase.file.deletions,
              patch: "",
              lines: [],
            },
          ],
        }),
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: `Show file information: ${testCase.stablePath}`,
      }),
    );

    const information = await screen.findByRole("dialog", {
      name: `File information: ${testCase.stablePath}`,
    });
    expect(information.className).toContain("bg-background");
    expect(information.className).toContain("text-foreground");
    expect(within(information).getByText("Project-relative path")).toBeTruthy();
    expect(within(information).getByText(testCase.stablePath)).toBeTruthy();
    expect(within(information).getByText("Absolute path")).toBeTruthy();
    expect(
      await within(information).findByText(
        `/repos/project/${testCase.stablePath}`,
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(information).getByRole("button", {
        name: `Copy project-relative path: ${testCase.stablePath}`,
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(testCase.stablePath),
    );
    fireEvent.click(
      within(information).getByRole("button", {
        name: `Copy absolute path: /repos/project/${testCase.stablePath}`,
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `/repos/project/${testCase.stablePath}`,
      ),
    );
    expect(within(information).getByText(testCase.file.status)).toBeTruthy();
    expect(
      within(information).getByText(`+${testCase.file.additions}`),
    ).toBeTruthy();
    expect(
      within(information).getByText(`−${testCase.file.deletions}`),
    ).toBeTruthy();
    expect(within(information).queryByText("Git command")).toBeNull();
    expect(
      within(information).queryByRole("button", {
        name: /copy .* git command/i,
      }),
    ).toBeNull();
    if (testCase.originalPath) {
      expect(within(information).getByText(testCase.originalPath)).toBeTruthy();
      fireEvent.click(
        within(information).getByRole("button", {
          name: `Copy original path: ${testCase.originalPath}`,
        }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(testCase.originalPath),
      );
    }
  });

  it("closes file information without closing the diff", async () => {
    const onClose = vi.fn();
    renderDialog({
      onClose,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [],
        }),
      },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show file information: web/src/a.ts",
      }),
    );
    const information = screen.getByRole("dialog", {
      name: "File information: web/src/a.ts",
    });
    fireEvent.keyDown(information, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", {
        name: "File information: web/src/a.ts",
      }),
    ).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show file information: web/src/a.ts",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close file information" }),
    );
    expect(
      screen.queryByRole("dialog", {
        name: "File information: web/src/a.ts",
      }),
    ).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("switches to raw file content and copies the full content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderDialog({
      handlers: {
        "pulls/fileAtRef": () => ({
          status: "ok",
          content: "const x = 1;\nconst y = 2;\n",
        }),
      },
    });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for web\/src\/a\.ts/i,
    });
    expect(within(dialog).getByText("const x = 1;")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Raw" }));

    expect(await within(dialog).findByText(/const x = 1;/)).toBeTruthy();
    expect(within(dialog).queryByText("+const x = 1;")).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Copy raw file: web/src/a.ts",
      }),
    );

    expect(writeText).toHaveBeenCalledWith("const x = 1;\nconst y = 2;\n");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Copied" }),
      ).toBeTruthy(),
    );
  });

  it("loads removed files from the base ref in raw mode", async () => {
    const removedFile: PullFile = {
      filename: "removed.txt",
      status: "removed",
      additions: 0,
      deletions: 1,
      patch: "@@ -1 +0,0 @@\n-old content",
    };
    const fileAtRef = vi.fn(() => ({
      status: "ok" as const,
      content: "old content\n",
    }));
    renderDialog({
      file: removedFile,
      handlers: { "pulls/fileAtRef": fileAtRef },
    });

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));

    expect(await screen.findByText("old content")).toBeTruthy();
    expect(fileAtRef).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "removed.txt",
        side: "base",
      }),
    );
  });

  it("integrates Markdown base/head preview into the diff dialog (#435)", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-# old\n+# new",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/fileAtRef": (p) =>
          p.side === "base"
            ? { status: "ok", content: "# old\n" }
            : { status: "ok", content: "# new\n" },
      },
    });

    const dialog = screen.getByRole("dialog", { name: /Diff for README.md/i });
    expect(
      within(dialog)
        .getAllByRole("button")
        .map(
          (button) =>
            button.getAttribute("aria-label") ?? button.textContent?.trim(),
        ),
    ).toEqual([
      "Toggle file filters",
      "README.md",
      "Copy file path: README.md",
      "Show file information: README.md",
      "Diff",
      "Raw",
      "Rendered diff",
      "Base",
      "Head",
      "Ignore whitespace",
      "Unified",
      "Split",
      "Close diff",
    ]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Head" }));
    expect(await screen.findByRole("heading", { name: "new" })).toBeTruthy();
    const headPane = dialog.querySelector(
      '[data-debug-component="MarkdownPreviewPane"]',
    );
    expect(headPane?.classList).toContain("markdown-diff-preview");
    expect(headPane?.className).not.toContain("bg-");
    expect(headPane?.className).not.toContain("text-");
    const preview = dialog.querySelector(".typeset-diff-preview");
    expect(preview).not.toBeNull();
    expect(preview?.classList.contains("typeset")).toBe(true);
    expect(preview?.classList.contains("markdown-body")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Base" }));
    expect(await screen.findByRole("heading", { name: "old" })).toBeTruthy();
    const basePane = dialog.querySelector(
      '[data-debug-component="MarkdownPreviewPane"]',
    );
    expect(basePane?.classList).toContain("markdown-diff-preview");
    expect(basePane?.className).not.toContain("bg-");
    expect(basePane?.className).not.toContain("text-");

    fireEvent.click(within(dialog).getByRole("button", { name: "Diff" }));
    expect(await within(dialog).findByText("# new")).toBeTruthy();
  });

  it("defaults rendered diff to unified and switches to the existing split view", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch: "@@ -1,3 +1,3 @@\n-# Old\n-old text\n+# New\n+new text",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 2,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,3 +1,3 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-# Old",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-old text",
                  left_line: 2,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+# New",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "addition",
                  text: "+new text",
                  left_line: null,
                  right_line: 2,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) =>
          params.side === "base"
            ? { status: "ok", content: "# Old\n\nold text\n" }
            : { status: "ok", content: "# New\n\nnew text\n" },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));

    expect(
      screen
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const renderedPane = document.querySelector(
      '[data-debug-component="RenderedDiffPane"]',
    );
    expect(renderedPane?.getAttribute("data-view-mode")).toBe("unified");
    expect(renderedPane?.classList).toContain("flex");
    expect(
      await screen.findByRole("region", { name: "Unified rendered diff" }),
    ).toBeTruthy();
    const baseRegion = await screen.findByRole("region", {
      name: "Base rendered diff",
    });
    const headRegion = screen.getByRole("region", {
      name: "Head rendered diff",
    });
    expect(
      baseRegion.compareDocumentPosition(headRegion) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Old" }).className).toContain(
        "markdown-diff-block-removed",
      );
      expect(screen.getByRole("heading", { name: "New" }).className).toContain(
        "markdown-diff-block-added",
      );
    });
    const unifiedTrackRule = postcss
      .parse(typesetCss)
      .nodes.find(
        (node) =>
          node.type === "rule" &&
          node.selector.includes("markdown-diff-unified-block-visible"),
      );
    expect(unifiedTrackRule?.toString()).toContain(
      "markdown-diff-unified-thread-group",
    );
    expect(unifiedTrackRule?.toString()).toContain("width: min(100%, 46rem)");
    expect(unifiedTrackRule?.toString()).toContain(
      "margin-block-start: 0.75rem",
    );

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(renderedPane?.getAttribute("data-view-mode")).toBe("split");
    expect(renderedPane?.classList).toContain("grid");
    expect(renderedPane?.classList).toContain("grid-cols-2");
    expect(
      screen
        .getByRole("button", { name: "Split" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const splitDocuments = document.querySelectorAll(
      ".typeset-diff-preview.markdown-diff-split-document",
    );
    expect(splitDocuments).toHaveLength(2);
    const splitTrackRule = postcss
      .parse(typesetCss)
      .nodes.find(
        (node) =>
          node.type === "rule" &&
          node.selector.includes("markdown-diff-split-document"),
      );
    expect(splitTrackRule?.toString()).toContain("width: min(100%, 46rem)");
    expect(splitTrackRule?.toString()).toContain("max-width: none");
  });

  it("interleaves rendered blocks from multiple hunks in source diff order", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch:
        "@@ -1,2 +1,2 @@\n-# Old first\n+# New first\n context\n@@ -5 +5 @@\n-## Old second\n+## New second",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 2,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,2 +1,2 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-# Old first",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+# New first",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "context",
                  text: " context",
                  left_line: 2,
                  right_line: 2,
                },
                {
                  kind: "hunk",
                  text: "@@ -5 +5 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-## Old second",
                  left_line: 5,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+## New second",
                  left_line: null,
                  right_line: 5,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content:
            params.side === "base"
              ? "# Old first\ncontext\n\n\n## Old second\n"
              : "# New first\ncontext\n\n\n## New second\n",
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    await screen.findByRole("heading", { name: "New second" });

    const orderedBlocks = Array.from(
      document.querySelectorAll(
        ".markdown-diff-unified-document > .markdown-diff-unified-block-visible",
      ),
    ).sort(
      (left, right) =>
        Number((left as HTMLElement).style.order) -
        Number((right as HTMLElement).style.order),
    );
    expect(orderedBlocks.map((block) => block.textContent?.trim())).toEqual([
      expect.stringContaining("Old first"),
      expect.stringContaining("New first"),
      expect.stringContaining("context"),
      expect.stringContaining("Old second"),
      expect.stringContaining("New second"),
    ]);
    expect(
      document.querySelectorAll(
        ".markdown-diff-unified-document > .markdown-diff-unified-block-hidden",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps each Mermaid comment action inside its ordered unified block", async () => {
    const baseDiagram = ["```mermaid", "flowchart TD", "  A --> B", "```"];
    const headDiagram = ["```mermaid", "flowchart TD", "  A --> C", "```"];
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 4,
      deletions: 4,
      patch: [
        "@@ -1,6 +1,6 @@",
        " # Diagram",
        " ",
        ...baseDiagram.map((line) => `-${line}`),
        ...headDiagram.map((line) => `+${line}`),
      ].join("\n"),
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 4,
              deletions: 4,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,6 +1,6 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "context",
                  text: " # Diagram",
                  left_line: 1,
                  right_line: 1,
                },
                {
                  kind: "context",
                  text: " ",
                  left_line: 2,
                  right_line: 2,
                },
                ...baseDiagram.map((line, index) => ({
                  kind: "deletion" as const,
                  text: `-${line}`,
                  left_line: index + 3,
                  right_line: null,
                })),
                ...headDiagram.map((line, index) => ({
                  kind: "addition" as const,
                  text: `+${line}`,
                  left_line: null,
                  right_line: index + 3,
                })),
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content: [
            "# Diagram",
            "",
            ...(params.side === "base" ? baseDiagram : headDiagram),
            "",
          ].join("\n"),
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    const baseButton = await screen.findByRole("button", {
      name: "Comment on base lines 3-6",
    });
    const headButton = screen.getByRole("button", {
      name: "Comment on head lines 3-6",
    });
    const baseBlock = baseButton.closest(".markdown-mermaid-block");
    const headBlock = headButton.closest(".markdown-mermaid-block");

    expect(
      baseBlock?.querySelector(".mermaid-diagram, pre code.language-mermaid"),
    ).not.toBeNull();
    expect(
      headBlock?.querySelector(".mermaid-diagram, pre code.language-mermaid"),
    ).not.toBeNull();
    expect(baseBlock?.classList).toContain("markdown-diff-block-removed");
    expect(headBlock?.classList).toContain("markdown-diff-block-added");
    expect(Number((baseBlock as HTMLElement).style.order)).toBeLessThan(
      Number((headBlock as HTMLElement).style.order),
    );
    expect(baseButton.closest(".markdown-diff-gutter")?.parentElement).toBe(
      baseBlock,
    );
    expect(headButton.closest(".markdown-diff-gutter")?.parentElement).toBe(
      headBlock,
    );
  });

  it("uses the original and target paths for a renamed Markdown rendered diff", async () => {
    const requests: { path: string; side: string }[] = [];
    const renamedFile: PullFile = {
      filename: "docs/README.md => docs/guide.md",
      previousFilename: "docs/README.md",
      headFilename: "docs/guide.md",
      status: "renamed",
      additions: 0,
      deletions: 0,
      patch: "",
    };
    renderDialog({
      file: renamedFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "docs/guide.md",
              original_path: "docs/README.md",
              status: "renamed",
              additions: 0,
              deletions: 0,
              patch: "",
              lines: [],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => {
          requests.push({ path: params.path, side: params.side });
          return { status: "ok", content: `# ${params.side}\n` };
        },
      },
    });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for docs\/README\.md => docs\/guide\.md/i,
    });
    expect(
      within(dialog).getByRole("button", { name: "Rendered diff" }),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Rendered diff" }),
    );
    await screen.findByRole("region", { name: "Base rendered diff" });
    expect(requests).toEqual(
      expect.arrayContaining([
        { path: "docs/README.md", side: "base" },
        { path: "docs/guide.md", side: "head" },
      ]),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Base" }));
    await screen.findByRole("heading", { name: "base" });
  });

  it("keeps a head selection off an unrelated base block with the same line number", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch:
        "@@ -1,3 +1,5 @@\n+Inserted intro\n+\n # Shared\n \n Base paragraph",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 0,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,3 +1,5 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+Inserted intro",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "addition",
                  text: "+",
                  left_line: null,
                  right_line: 2,
                },
                {
                  kind: "context",
                  text: " # Shared",
                  left_line: 1,
                  right_line: 3,
                },
                {
                  kind: "context",
                  text: " ",
                  left_line: 2,
                  right_line: 4,
                },
                {
                  kind: "context",
                  text: " Base paragraph",
                  left_line: 3,
                  right_line: 5,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content:
            params.side === "base"
              ? "# Shared\n\nBase paragraph\n"
              : "Inserted intro\n\n# Shared\n\nBase paragraph\n",
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Comment on head lines 3-3" }),
    );
    const baseRegion = screen.getByRole("region", {
      name: "Base rendered diff",
    });
    const headRegion = screen.getByRole("region", {
      name: "Head rendered diff",
    });
    const expectOnlyHeadSelected = () => {
      expect(
        within(headRegion).getByRole("heading", { name: "Shared" }).className,
      ).toContain("markdown-diff-block-selected");
      expect(
        within(baseRegion).getByText("Base paragraph").className,
      ).not.toContain("markdown-diff-block-selected");
    };

    expectOnlyHeadSelected();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expectOnlyHeadSelected();
    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expectOnlyHeadSelected();
  });

  it("puts the comment button in a left gutter and the composer below the block", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch:
        "@@ -1,7 +1,7 @@\n # Title\n \n-Old paragraph\n+New paragraph\n \n | Field | Meaning |\n | --- | --- |\n-| line | old |\n+| line | new |",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 2,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,7 +1,7 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "context",
                  text: " # Title",
                  left_line: 1,
                  right_line: 1,
                },
                {
                  kind: "context",
                  text: " ",
                  left_line: 2,
                  right_line: 2,
                },
                {
                  kind: "deletion",
                  text: "-Old paragraph",
                  left_line: 3,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+New paragraph",
                  left_line: null,
                  right_line: 3,
                },
                {
                  kind: "context",
                  text: " ",
                  left_line: 4,
                  right_line: 4,
                },
                {
                  kind: "context",
                  text: " | Field | Meaning |",
                  left_line: 5,
                  right_line: 5,
                },
                {
                  kind: "context",
                  text: " | --- | --- |",
                  left_line: 6,
                  right_line: 6,
                },
                {
                  kind: "deletion",
                  text: "-| line | old |",
                  left_line: 7,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+| line | new |",
                  left_line: null,
                  right_line: 7,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content:
            params.side === "base"
              ? "# Title\n\nOld paragraph\n\n| Field | Meaning |\n| --- | --- |\n| line | old |\n"
              : "# Title\n\nNew paragraph\n\n| Field | Meaning |\n| --- | --- |\n| line | new |\n",
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    const button = await screen.findByRole("button", {
      name: "Comment on head lines 3-3",
    });
    const gutter = button.closest(".markdown-diff-gutter");
    // The gutter is a direct child of its block, which is what the unified stylesheet needs to
    // pull it out of the text flow, and it names the Markdown source line of the range.
    expect(gutter?.parentElement).toBe(screen.getByText("New paragraph"));
    // The line carries the raw diff's sign too, so the change reads without color.
    expect(gutter?.textContent).toBe("+3");
    expect(
      screen
        .getByRole("button", { name: "Comment on base lines 3-3" })
        .closest(".markdown-diff-gutter")?.textContent,
    ).toBe("−3");
    expect(
      screen
        .getByRole("button", { name: "Comment on head lines 1-1" })
        .closest(".markdown-diff-gutter")?.textContent,
    ).toBe("1");

    fireEvent.click(button);
    const block = screen.getByText("New paragraph");
    const composer = screen.getByLabelText("Diff comment");
    const group = composer.closest(".markdown-diff-unified-thread-group");
    expect(group).not.toBeNull();
    expect(block.nextElementSibling).toBe(group);
    // The composer shares the block's slot in the unified column, right after the block itself.
    expect((group as HTMLElement).style.order).toBe(
      String(Number((block as HTMLElement).style.order) + 1),
    );

    // A table row has no gutter of its own; its button stays inline in a cell.
    const rowButton = screen.getByRole("button", {
      name: "Comment on head lines 7-7",
    });
    expect(rowButton.closest(".markdown-diff-gutter")).toBeNull();
    expect(rowButton.closest("td")).not.toBeNull();
    // The table names the source lines its rows span, since the rows cannot each show a number.
    const tableGutter = rowButton.closest(
      ".markdown-diff-table-block",
    )?.firstElementChild;
    expect(tableGutter?.className).toContain("markdown-diff-gutter");
    expect(tableGutter?.textContent).toContain("5–7");

    // Split shares the gutter but keeps its own composer placement.
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(
      screen
        .getByLabelText("Diff comment")
        .closest(".markdown-diff-unified-thread-group"),
    ).toBeNull();
    const splitGutter = screen
      .getByRole("button", { name: "Comment on head lines 3-3" })
      .closest(".markdown-diff-gutter");
    expect(splitGutter?.parentElement).toBe(screen.getByText("New paragraph"));
    expect(splitGutter?.textContent).toContain("3");

    // Without a selection the split grid holds the two panes only — an empty composer wrapper
    // would take a full grid row and push them down.
    const pane = document.querySelector(
      '[data-debug-component="RenderedDiffPane"]',
    );
    expect(pane?.children).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Diff comment")).toBeNull();
    expect(pane?.children).toHaveLength(2);
  });

  it.each([
    {
      status: "added" as const,
      missingSide: "base",
      availableSide: "head",
    },
    {
      status: "removed" as const,
      missingSide: "head",
      availableSide: "base",
    },
  ])("shows the missing and available sides of a $status file in both rendered views", async ({
    status,
    missingSide,
    availableSide,
  }) => {
    const changedFile: PullFile = {
      filename: "README.md",
      status,
      additions: status === "added" ? 1 : 0,
      deletions: status === "removed" ? 1 : 0,
      patch:
        status === "added"
          ? "@@ -0,0 +1 @@\n+# Added"
          : "@@ -1 +0,0 @@\n-# Removed",
    };
    renderDialog({
      file: changedFile,
      handlers: {
        "pulls/fileAtRef": (params) =>
          params.side === missingSide
            ? { status: "missing" }
            : { status: "ok", content: `# ${availableSide}\n` },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    expect(
      await screen.findByText(`N/A — file does not exist on ${missingSide}.`),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: availableSide })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(
      screen.getByText(`N/A — file does not exist on ${missingSide}.`),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: availableSide })).toBeTruthy();
  });

  it("keeps binary, loading, and fetch failure states visible in both rendered views", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => {
          throw new RpcFault(500, "diff unavailable");
        },
        "pulls/fileAtRef": (params) => {
          if (params.side === "base") return { status: "binary" };
          return new Promise(() => {});
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    expect(
      await screen.findByText("N/A — binary file, cannot render as Markdown."),
    ).toBeTruthy();
    expect(screen.getByText("Loading rendered diff…")).toBeTruthy();
    expect(
      await screen.findByText("Failed to load diff annotations."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(
      screen.getByText("N/A — binary file, cannot render as Markdown."),
    ).toBeTruthy();
    expect(screen.getByText("Loading rendered diff…")).toBeTruthy();
    expect(screen.getByText("Failed to load diff annotations.")).toBeTruthy();
  });

  it("keeps a rendered content failure visible after switching views", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/fileAtRef": () => {
          throw new RpcFault(500, "content unavailable");
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));
    expect(
      await screen.findByText("Failed to load base preview."),
    ).toBeTruthy();
    expect(screen.getByText("Failed to load head preview.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByText("Failed to load base preview.")).toBeTruthy();
    expect(screen.getByText("Failed to load head preview.")).toBeTruthy();
  });

  it("keeps list and table container threads visible in both rendered views", async () => {
    const baseContent = [
      "- Base item",
      "",
      "| Header |",
      "| --- |",
      "| Base value |",
    ].join("\n");
    const headContent = [
      "- Head item",
      "",
      "| Header |",
      "| --- |",
      "| Head value |",
    ].join("\n");
    const patch = [
      "@@ -1,5 +1,5 @@",
      "-- Base item",
      "+- Head item",
      " ",
      " | Header |",
      " | --- |",
      "-| Base value |",
      "+| Head value |",
    ].join("\n");
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch,
    };
    const listThread = feedbackThread({
      anchor: {
        ...feedbackThread().anchor,
        path: "README.md",
        start_line: 1,
        end_line: 1,
      },
      messages: [
        {
          ...feedbackThread().messages[0],
          body: "List thread",
        },
      ],
    });
    const tableThread = feedbackThread({
      id: 2,
      anchor: {
        ...feedbackThread().anchor,
        path: "README.md",
        start_line: 4,
        end_line: 4,
      },
      messages: [
        {
          ...feedbackThread().messages[0],
          id: 12,
          thread_id: 2,
          body: "Table delimiter thread",
        },
      ],
    });
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 2,
              deletions: 2,
              patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,5 +1,5 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-- Base item",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+- Head item",
                  left_line: null,
                  right_line: 1,
                },
                {
                  kind: "context",
                  text: " ",
                  left_line: 2,
                  right_line: 2,
                },
                {
                  kind: "context",
                  text: " | Header |",
                  left_line: 3,
                  right_line: 3,
                },
                {
                  kind: "context",
                  text: " | --- |",
                  left_line: 4,
                  right_line: 4,
                },
                {
                  kind: "deletion",
                  text: "-| Base value |",
                  left_line: 5,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+| Head value |",
                  left_line: null,
                  right_line: 5,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content: params.side === "base" ? baseContent : headContent,
        }),
        "diffFeedback/list": () => ({
          threads: [listThread, tableThread],
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));

    const assertContainerThreads = async (unified: boolean) => {
      const listCard = await screen.findByLabelText("Diff thread 1");
      const tableCard = screen.getByLabelText("Diff thread 2");
      expect(listCard.parentElement?.previousElementSibling?.tagName).toBe(
        "UL",
      );
      // A table's block is its wrapper, which also carries the gutter naming its line range.
      const tableBlock = tableCard.parentElement?.previousElementSibling;
      expect(tableBlock?.classList.contains("markdown-diff-table-block")).toBe(
        true,
      );
      expect(tableBlock?.querySelector("table")).not.toBeNull();
      expect(
        listCard.parentElement?.classList.contains(
          "markdown-diff-unified-thread-group",
        ),
      ).toBe(unified);
      expect(
        tableCard.parentElement?.classList.contains(
          "markdown-diff-unified-thread-group",
        ),
      ).toBe(unified);
      expect(screen.queryByLabelText("Previous diff threads")).toBeNull();
    };

    await assertContainerThreads(true);
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    await assertContainerThreads(false);
  });

  it("does not duplicate side-specific rendered threads as previous threads", async () => {
    const baseContent = "# Shared\n\n# Base only\n";
    const headContent = "# Shared\n\n\n\n# Head only\n";
    const patch = [
      "@@ -1,3 +1,5 @@",
      " # Shared",
      "-",
      "-# Base only",
      "+",
      "+",
      "+",
      "+# Head only",
    ].join("\n");
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 4,
      deletions: 2,
      patch,
    };
    const baseThread = feedbackThread({
      anchor: {
        ...feedbackThread().anchor,
        path: "README.md",
        side: "LEFT",
        start_line: 3,
        end_line: 3,
      },
      messages: [
        {
          ...feedbackThread().messages[0],
          body: "Base-only thread",
        },
      ],
    });
    const headThread = feedbackThread({
      id: 2,
      anchor: {
        ...feedbackThread().anchor,
        path: "README.md",
        side: "RIGHT",
        start_line: 5,
        end_line: 5,
      },
      messages: [
        {
          ...feedbackThread().messages[0],
          id: 12,
          thread_id: 2,
          body: "Head-only thread",
        },
      ],
    });
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 4,
              deletions: 2,
              patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1,3 +1,5 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "context",
                  text: " # Shared",
                  left_line: 1,
                  right_line: 1,
                },
                {
                  kind: "deletion",
                  text: "-",
                  left_line: 2,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-# Base only",
                  left_line: 3,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+",
                  left_line: null,
                  right_line: 2,
                },
                {
                  kind: "addition",
                  text: "+",
                  left_line: null,
                  right_line: 3,
                },
                {
                  kind: "addition",
                  text: "+",
                  left_line: null,
                  right_line: 4,
                },
                {
                  kind: "addition",
                  text: "+# Head only",
                  left_line: null,
                  right_line: 5,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content: params.side === "base" ? baseContent : headContent,
        }),
        "diffFeedback/list": () => ({
          threads: [baseThread, headThread],
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));

    const assertInlineOnly = async () => {
      expect(await screen.findByText("Base-only thread")).toBeTruthy();
      expect(screen.getByText("Head-only thread")).toBeTruthy();
      expect(screen.getAllByLabelText("Diff thread 1")).toHaveLength(1);
      expect(screen.getAllByLabelText("Diff thread 2")).toHaveLength(1);
      expect(screen.queryByLabelText("Previous diff threads")).toBeNull();
    };

    await assertInlineOnly();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    await assertInlineOnly();
  });

  it("creates a rendered diff comment and shows its inline conversation", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-# Old\n+# New",
    };
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      thread: feedbackThread({
        id: 8,
        anchor: {
          ...feedbackThread().anchor,
          path: "README.md",
          side: "RIGHT",
          start_line: 1,
          end_line: 1,
        },
        resolved_anchor: {
          path: "README.md",
          original_path: null,
          side: "RIGHT",
          start_line: 1,
          end_line: 1,
        },
        messages: [
          {
            ...feedbackThread().messages[0],
            id: 18,
            thread_id: 8,
            author: "me",
            body: input.body as string,
          },
        ],
      }),
    }));
    const unresolvedInlineThread = feedbackThread({
      id: 7,
      anchor: {
        ...feedbackThread().anchor,
        path: "README.md",
        side: "RIGHT",
        start_line: 999,
        end_line: 999,
      },
      resolved_anchor: {
        path: "README.md",
        original_path: null,
        side: "RIGHT",
        start_line: 999,
        end_line: 999,
      },
      placement: "inline",
    });
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-# Old",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+# New",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content: params.side === "base" ? "# Old\n" : "# New\n",
        }),
        "diffFeedback/list": () => ({ threads: [unresolvedInlineThread] }),
        "diffFeedback/create": create,
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Rendered diff" }),
    );
    await screen.findByRole("heading", { name: "New" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Previous diff threads" }),
    );
    expect(await screen.findByLabelText("Diff thread 7")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Comment on head lines 1-1" }),
    );
    expect(screen.getByRole("heading", { name: "New" }).className).toContain(
      "markdown-diff-block-selected",
    );
    expect(
      screen.getByRole("heading", { name: "Old" }).className,
    ).not.toContain("markdown-diff-block-selected");
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "Rendered feedback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(
      (screen.getByLabelText("Diff comment") as HTMLTextAreaElement).value,
    ).toBe("Rendered feedback");
    expect(screen.getByRole("heading", { name: "New" }).className).toContain(
      "markdown-diff-block-selected",
    );
    expect(
      screen.getByRole("heading", { name: "Old" }).className,
    ).not.toContain("markdown-diff-block-selected");
    fireEvent.click(screen.getByRole("button", { name: "Unified" }));
    expect(
      (screen.getByLabelText("Diff comment") as HTMLTextAreaElement).value,
    ).toBe("Rendered feedback");
    expect(screen.getByRole("heading", { name: "New" }).className).toContain(
      "markdown-diff-block-selected",
    );
    expect(
      screen.getByRole("heading", { name: "Old" }).className,
    ).not.toContain("markdown-diff-block-selected");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          path: "README.md",
          side: "RIGHT",
          start_line: 1,
          end_line: 1,
          body: "Rendered feedback",
        }),
      ),
    );
  });

  it("keeps the rendered blocks mounted while opening and closing the composer", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-# Old\n+# New",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                {
                  kind: "deletion",
                  text: "-# Old",
                  left_line: 1,
                  right_line: null,
                },
                {
                  kind: "addition",
                  text: "+# New",
                  left_line: null,
                  right_line: 1,
                },
              ],
            },
          ],
        }),
        "pulls/fileAtRef": (params) => ({
          status: "ok",
          content: params.side === "base" ? "# Old\n" : "# New\n",
        }),
        "diffFeedback/list": () => ({ threads: [] }),
        "diffFeedback/create": async (input: Record<string, unknown>) => ({
          thread: feedbackThread({
            id: 9,
            anchor: {
              ...feedbackThread().anchor,
              path: "README.md",
              side: "RIGHT",
              start_line: 1,
              end_line: 1,
            },
            resolved_anchor: {
              path: "README.md",
              original_path: null,
              side: "RIGHT",
              start_line: 1,
              end_line: 1,
            },
            messages: [
              {
                ...feedbackThread().messages[0],
                id: 19,
                thread_id: 9,
                author: "me",
                body: input.body as string,
              },
            ],
          }),
        }),
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Rendered diff" }),
    );
    // Remounting the rendered document would drop the scroll container's children and reset its
    // scroll position, so the block a reader clicked has to stay the very same DOM node.
    const heading = await screen.findByRole("heading", { name: "New" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Comment on head lines 1-1" }),
    );
    await screen.findByLabelText("Diff comment");
    expect(screen.getByRole("heading", { name: "New" })).toBe(heading);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Diff comment")).toBeNull();
    expect(screen.getByRole("heading", { name: "New" })).toBe(heading);

    fireEvent.click(
      screen.getByRole("button", { name: "Comment on head lines 1-1" }),
    );
    fireEvent.change(await screen.findByLabelText("Diff comment"), {
      target: { value: "Rendered feedback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Diff comment")).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "New" })).toBe(heading);
  });

  it("renders GFM, tables, images, Mermaid, and long content in both panes", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    const content = `# Rendered content

Paragraph with **GFM** and [a link](https://example.com).

| Column | Value |
| --- | --- |
| Cell | 1 |

![An image](https://example.com/image.png)

\`\`\`mermaid
flowchart TD
  A[Start] --> B[Finish]
\`\`\`

${Array.from({ length: 120 }, (_, index) => `Long paragraph ${index + 1}.`).join("\n\n")}
`;
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/diff": () => ({
          base_sha: "a".repeat(40),
          head_sha: "b".repeat(40),
          files: [
            {
              path: "README.md",
              original_path: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              patch: mdFile.patch,
              lines: [
                {
                  kind: "hunk",
                  text: "@@ -1 +1 @@",
                  left_line: null,
                  right_line: null,
                },
                ...content.split("\n").map((text, index) => ({
                  kind: "addition" as const,
                  text: `+${text}`,
                  left_line: null,
                  right_line: index + 1,
                })),
              ],
            },
          ],
        }),
        "pulls/fileAtRef": () => ({ status: "ok", content }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Rendered diff" }));

    const headings = await screen.findAllByRole("heading", {
      name: "Rendered content",
    });
    const heading = headings[1];
    const headPane = heading.closest("[aria-label='Head rendered diff']");
    expect(headPane?.querySelector("table")).not.toBeNull();
    expect(headPane?.querySelector("a")).not.toBeNull();
    const image = headPane?.querySelector("img");
    expect(image).not.toBeNull();
    expect(
      image?.parentElement?.classList.contains("markdown-diff-block-added"),
    ).toBe(true);
    // The diagram renders asynchronously, so the block is either the rendered SVG or, until then,
    // its Mermaid source.
    expect(
      headPane?.querySelector(".mermaid-diagram, pre code.language-mermaid"),
    ).not.toBeNull();
    expect(headPane?.textContent).toContain("Long paragraph 120.");
    expect(
      document
        .querySelector("[aria-label='Unified rendered diff']")
        ?.querySelector(".markdown-diff-preview")
        ?.classList.contains("overflow-y-auto"),
    ).toBe(true);
  });

  it("lets a long Markdown preview scroll inside its own pane", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-# old\n+# new\n",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/fileAtRef": () => ({
          status: "ok",
          content: `# Title\n\n${Array.from(
            { length: 200 },
            (_, index) => `Paragraph ${index + 1}.`,
          ).join("\n\n")}\n`,
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Head" }));

    const heading = await screen.findByRole("heading", { name: "Title" });
    const pane = heading.closest(
      '[data-debug-component="MarkdownPreviewPane"]',
    );
    // The pane, not the dialog's shared scroller, owns the scrollbar so it
    // renders with the preview's own palette.
    expect(pane?.classList).toContain("overflow-y-auto");
    expect(pane?.classList).toContain("h-full");
    expect(pane?.parentElement?.classList).toContain("overflow-auto");
  });

  it("renders GFM elements inside the diff preview typeset", async () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "added",
      additions: 12,
      deletions: 0,
      patch: "@@ -0,0 +1,12 @@",
    };
    renderDialog({
      file: mdFile,
      handlers: {
        "pulls/fileAtRef": () => ({
          status: "ok",
          content:
            "# Title\n\nParagraph with [link](https://example.com) and `code`.\n\n> Quote sharing a block with a wide table.\n>\n> | Nested column |\n> | --- |\n> | Nested cell |\n\n- Item sharing a list with wide code\n\n  ```ts\n  const nested = 1;\n  ```\n\n- Regular sibling item\n\n| Column |\n| --- |\n| Cell |\n\n```ts\nconst value = 1;\n```\n",
        }),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Head" }));

    const preview = await screen.findByRole("heading", { name: "Title" });
    const typeset = preview.closest(".typeset-diff-preview");
    const paragraph = typeset?.querySelector("p");
    const directChildren = Array.from(typeset?.children ?? []);
    const table = directChildren.find((child) => child.tagName === "TABLE");
    const pre = directChildren.find((child) => child.tagName === "PRE");
    expect(paragraph).not.toBeNull();
    expect(typeset?.querySelector("a")).not.toBeNull();
    expect(typeset?.querySelector("blockquote")).not.toBeNull();
    expect(typeset?.querySelector("ul")).not.toBeNull();
    expect(table).not.toBeNull();
    expect(typeset?.querySelector("code")).not.toBeNull();
    expect(pre).not.toBeNull();
    expect(paragraph?.parentElement).toBe(typeset);
    expect(table?.parentElement).toBe(typeset);
    expect(pre?.parentElement).toBe(typeset);
    const nestedTable = typeset?.querySelector("blockquote table");
    const nestedPre = typeset?.querySelector("li pre");
    const mixedBlockquoteParagraph = typeset?.querySelector("blockquote p");
    const regularListItem = Array.from(
      typeset?.querySelectorAll("li") ?? [],
    ).find((item) => item.textContent?.includes("Regular sibling item"));
    expect(nestedTable).not.toBeNull();
    expect(nestedPre).not.toBeNull();
    expect(mixedBlockquoteParagraph).not.toBeNull();
    expect(regularListItem).not.toBeUndefined();
    expect(nestedTable?.closest("blockquote")?.parentElement).toBe(typeset);
    expect(nestedPre?.closest("ul")?.parentElement).toBe(typeset);
    expect(
      mixedBlockquoteParagraph
        ?.closest("blockquote")
        ?.contains(nestedTable ?? null),
    ).toBe(true);
    expect(regularListItem?.parentElement?.contains(nestedPre ?? null)).toBe(
      true,
    );
    const rules: { selector: string; maxWidth?: string }[] = [];
    postcss.parse(typesetCss).walkRules((rule) => {
      let maxWidth: string | undefined;
      rule.walkDecls("max-width", (declaration) => {
        maxWidth = declaration.value;
      });
      rules.push({
        selector: rule.selector,
        maxWidth,
      });
    });
    const wideRule = rules.find(
      (rule) =>
        rule.selector.includes(":where(table, :has(table))") &&
        rule.maxWidth === "100%",
    );
    const readingMeasureRule = rules.find(
      (rule) =>
        rule.selector.includes(":not(table, :has(table))") &&
        rule.maxWidth === "46rem",
    );
    const mixedContentRule = rules.find(
      (rule) =>
        rule.selector.includes("li:not(:has(table))") &&
        rule.maxWidth === "46rem",
    );
    expect(wideRule).not.toBeUndefined();
    expect(wideRule?.selector).not.toContain(":has(pre");
    expect(readingMeasureRule).not.toBeUndefined();
    expect(mixedContentRule).not.toBeUndefined();
    expect(mixedContentRule?.selector).toContain(
      ":where(p, h1, h2, h3, h4, h5, h6)",
    );
  });

  it("restores the Markdown mode after visiting a non-Markdown file", () => {
    const mdFile: PullFile = {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-# old\n+# new",
    };
    const view = renderDialog({ file: mdFile });

    fireEvent.click(screen.getByRole("button", { name: "Head" }));
    expect(
      screen.getByRole("button", { name: "Head" }).getAttribute("aria-pressed"),
    ).toBe("true");

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DiffFileDialog
          owner="me"
          repo="proj"
          number={30}
          files={[{ ...file, filename: "web/src/a.ts" }]}
          file={{ ...file, filename: "web/src/a.ts" }}
          onSelectFile={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Diff" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "Head" })).toBeNull();

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DiffFileDialog
          owner="me"
          repo="proj"
          number={30}
          files={[mdFile]}
          file={mdFile}
          onSelectFile={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Head" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("starts in Diff mode when the dialog is reopened", () => {
    const view = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    view.unmount();

    renderDialog();
    expect(
      screen.getByRole("button", { name: "Diff" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("hides Preview but copies the target path for a renamed Markdown file (mangled numstat path, #436)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // git numstat renders a cross-directory rename as "old => new" — this still ends in ".md" but
    // is not a resolvable git path, so `pulls.fileAtRef` would always report "missing" for it.
    const renamedFile: PullFile = {
      filename: "docs/old.md => top.md",
      status: "renamed",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n-# old\n+# old\n+extra",
    };
    renderDialog({ file: renamedFile });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy file path: top.md" }),
      );
    });
    expect(writeText).toHaveBeenCalledWith("top.md");
    expect(screen.queryByRole("button", { name: /^Preview$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Base" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Head" })).toBeNull();
  });

  it("copies the target path for a braced renamed file path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const renamedFile: PullFile = {
      filename: "sub/{old/name.md => new/name2.md}",
      status: "renamed",
      additions: 1,
      deletions: 0,
      patch: "",
    };
    renderDialog({ file: renamedFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for sub\/\{old\/name\.md => new\/name2\.md\}/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: sub/new/name2.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("sub/new/name2.md");
  });

  it("copies structured head filenames for renamed targets containing the rename marker text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const renamedFile: PullFile = {
      filename: "old.txt => new => target.txt",
      previousFilename: "old.txt",
      headFilename: "new => target.txt",
      status: "renamed",
      additions: 0,
      deletions: 0,
      patch: "",
    };
    renderDialog({ file: renamedFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for old\.txt => new => target\.txt/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: new => target.txt",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("new => target.txt");
  });

  it("keeps the diff dialog copy button for a non-renamed file path containing the rename marker text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const literalMarkerFile: PullFile = {
      filename: "docs/a => b.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({ file: literalMarkerFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for docs\/a => b\.ts/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/a => b.ts",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/a => b.ts");
  });

  it("copies a visible escaped path for filenames with hidden control characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const controlCharFile: PullFile = {
      filename: "docs/readme\n\tinstall.md",
      headFilename: "docs/readme\n\tinstall.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({ file: controlCharFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for docs\/readme\s+install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\n\\tinstall.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\n\\tinstall.md");
  });

  it("copies a visible escaped path for filenames with zero-width characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const zeroWidthFile: PullFile = {
      filename: "docs/readme\u200binstall.md",
      headFilename: "docs/readme\u200binstall.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({ file: zeroWidthFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for docs\/readme.*install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\u200binstall.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\u200binstall.md");
  });

  it("copies a visible escaped path for filenames with default-ignorable characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const defaultIgnorableFile: PullFile = {
      filename: "docs/readme\ufe0finstall.md",
      headFilename: "docs/readme\ufe0finstall.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({ file: defaultIgnorableFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for docs\/readme.*install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\ufe0finstall.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\ufe0finstall.md");
  });

  it("copies a braced escape for supplementary default-ignorable characters", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const supplementaryFile: PullFile = {
      filename: "docs/readme\u{e0100}install.md",
      headFilename: "docs/readme\u{e0100}install.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
    };
    renderDialog({ file: supplementaryFile });

    const dialog = screen.getByRole("dialog", {
      name: /Diff for docs\/readme.*install\.md/i,
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: "Copy file path: docs/readme\\u{e0100}install.md",
        }),
      );
    });

    expect(writeText).toHaveBeenCalledWith("docs/readme\\u{e0100}install.md");
  });
});

describe("DiffFeedbackHistory", () => {
  it("shows a visible error when previous threads cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "diffFeedback/list": () => {
          throw new RpcFault(500, "database unavailable");
        },
      }),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <DiffFeedbackHistory owner="me" repo="proj" number={30} />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "Failed to load previous diff threads. database unavailable",
      ),
    ).toBeTruthy();
  });

  it("shows orphaned conversations beside an empty or non-empty diff", async () => {
    const list = vi.fn(() => ({
      threads: [
        feedbackThread({
          id: 7,
          anchor: {
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            path: "removed.ts",
            original_path: null,
            side: "LEFT",
            start_line: 2,
            end_line: 3,
          },
          freshness: "unavailable",
          created_by: "reviewer",
          created_by_type: "agent",
          created_at: "2026-07-28T00:00:00Z",
          messages: [
            {
              id: 11,
              thread_id: 7,
              author: "reviewer",
              author_type: "agent",
              body: "This conversation remains visible.",
              created_at: "2026-07-28T00:00:00Z",
            },
          ],
        }),
      ],
    }));
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "diffFeedback/list": list,
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <div>
          <p>No diff.</p>
          <DiffFeedbackHistory owner="me" repo="proj" number={30} />
        </div>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("No diff.")).toBeTruthy();
    const section = await screen.findByLabelText("Previous diff threads");
    const toggle = within(section).getByRole("button", {
      name: "Previous diff threads",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(section).queryByLabelText("Diff thread 7")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const card = within(section).getByLabelText("Diff thread 7");
    expect(within(card).queryByText("Unavailable")).toBeNull();
    expect(
      within(card).getByText("This conversation remains visible."),
    ).toBeTruthy();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ orphaned: true }),
    );
    expect(
      screen.getByRole("button", { name: "Actions for diff thread 7" }),
    ).toBeTruthy();
    expect(screen.queryByText("Pending")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /submit (review|comments)/i }),
    ).toBeNull();
  });

  it("explains inline unavailable fallback separately for human and agent conversations", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "diffFeedback/list": () => ({
          threads: [
            feedbackThread({
              id: 7,
              freshness: "unavailable",
              placement: "inline",
              created_by: "unknown",
              created_by_type: "human",
              messages: [
                {
                  ...feedbackThread().messages[0],
                  thread_id: 7,
                  author: "unknown",
                  author_type: "human",
                },
              ],
            }),
            feedbackThread({
              id: 8,
              freshness: "outdated",
              created_by: "executor #12-1",
              created_by_type: "agent",
              messages: [
                {
                  ...feedbackThread().messages[0],
                  thread_id: 8,
                  author: "executor #12-1",
                  author_type: "agent",
                },
              ],
            }),
          ],
        }),
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DiffFeedbackHistory owner="me" repo="proj" number={30} />
      </QueryClientProvider>,
    );

    const section = await screen.findByLabelText("Previous diff threads");
    fireEvent.click(
      within(section).getByRole("button", { name: "Previous diff threads" }),
    );

    const humanThread = within(section).getByLabelText("Diff thread 7");
    expect(within(humanThread).getByText("@human")).toBeTruthy();
    expect(within(humanThread).queryByText("Unavailable")).toBeNull();
    fireEvent.click(
      within(humanThread).getByRole("button", {
        name: "Show diff anchor information for thread 7",
      }),
    );
    expect(within(humanThread).getByText("Unavailable")).toBeTruthy();
    expect(within(humanThread).getByText("RIGHT 1–2")).toBeTruthy();
    for (const agentStatus of ["working", "blocked", "done", "idle"]) {
      expect(within(humanThread).queryByText(agentStatus)).toBeNull();
    }

    const agentThread = within(section).getByLabelText("Diff thread 8");
    expect(within(agentThread).getByText("@executor #12-1")).toBeTruthy();
    expect(within(agentThread).queryByText("Outdated")).toBeNull();
    fireEvent.click(
      within(agentThread).getByRole("button", {
        name: "Show diff anchor information for thread 8",
      }),
    );
    expect(within(agentThread).getByText("Outdated")).toBeTruthy();
    expect(within(agentThread).getByText("Modified")).toBeTruthy();
  });
});
