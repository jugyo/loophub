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
import { mockRpcFetch } from "@/api/rpc-mock";
import type { PullFile, PullLineComment } from "@/api/types";

import { DiffFileDialog } from "./pull-diff-dialog";

const typesetCss = readFileSync(resolve("src/typeset.css"), "utf8");

afterEach(() => {
  cleanup();
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

const lineComments: PullLineComment[] = [
  {
    id: 1,
    pull_request_review_id: 1,
    user: { login: "design-bot" },
    path: "web/src/a.ts",
    line: 1,
    side: "RIGHT",
    body: "nice constant",
    created_at: "2026-06-18T11:30:00Z",
  },
];

function renderDialog({
  file: dialogFile = file,
  files,
  comments = [],
  onSelectFile = () => {},
  onClose = () => {},
  handlers = {},
}: {
  file?: PullFile;
  files?: PullFile[];
  comments?: PullLineComment[];
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
        comments={comments}
        onSelectFile={onSelectFile}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

describe("DiffFileDialog", () => {
  it("renders the diff with its line comments", () => {
    renderDialog({ comments: lineComments });

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
        .getByRole("button", { name: "Split" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(dialog).getAllByText("nice constant").length).toBeGreaterThan(
      0,
    );
  });

  it("starts in split view and switches to unified view", () => {
    const splitFile: PullFile = {
      ...file,
      additions: 2,
      patch:
        "@@ -1,2 +1,3 @@\n-const x = 0;\n+const x = 1;\n+const y = 2;\n keep",
    };
    const { container } = renderDialog({ file: splitFile });

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

    fireEvent.click(screen.getByRole("button", { name: "Unified" }));

    expect(
      screen
        .getByRole("button", { name: "Unified" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector("colgroup")).toBeNull();
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
    expect(screen.getAllByText("line 100")).toHaveLength(2);
    expect(scroller?.classList).toContain("overflow-auto");
    expect(rightPane?.classList).toContain("min-h-0");
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

  it("lists changed file details flat and selects a file from the sidebar", () => {
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
        .getByRole("button", { name: /web\/src\/a\.ts/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(
      within(sidebar).getByLabelText("File status: modified"),
    ).toBeTruthy();
    expect(within(sidebar).getByText("+1")).toBeTruthy();
    expect(within(sidebar).getByText("−1")).toBeTruthy();
    expect(within(sidebar).getByLabelText("File status: added")).toBeTruthy();
    expect(within(sidebar).getByText("+4")).toBeTruthy();

    fireEvent.click(
      within(sidebar).getByRole("button", { name: /core\/nested\/b\.ts/ }),
    );
    expect(onSelectFile).toHaveBeenCalledWith("core/nested/b.ts");
    expect(within(sidebar).queryByText("core")).toBeNull();
    expect(within(sidebar).queryByText("nested")).toBeNull();
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
    expect(within(sidebar).getByText("web/src/a.ts")).toBeTruthy();
    expect(within(sidebar).queryByText("web/src/a.test.ts")).toBeNull();
    expect(within(sidebar).queryByText("a.test.ts")).toBeNull();
    expect(within(sidebar).queryByText("core/b.ts")).toBeNull();

    fireEvent.change(within(sidebar).getByLabelText("Include files"), {
      target: { value: "" },
    });
    fireEvent.change(within(sidebar).getByLabelText("Exclude files"), {
      target: { value: "" },
    });
    expect(within(sidebar).getByText("Files changed (5)")).toBeTruthy();
    expect(within(sidebar).getByText("README.md")).toBeTruthy();

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
          comments={[]}
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
      "Diff",
      "Raw",
      "Base",
      "Head",
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
        rule.selector.includes(":has(pre, table)") && rule.maxWidth === "100%",
    );
    const mixedContentRule = rules.find(
      (rule) =>
        rule.selector.includes("li:not(:has(pre, table))") &&
        rule.maxWidth === "46rem",
    );
    expect(wideRule).not.toBeUndefined();
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
          comments={[]}
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
          comments={[]}
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
