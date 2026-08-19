import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PrChangeMap, PullFile } from "@/api/types";

import { PrChangeMapDialog } from "./pr-change-map-dialog";

afterEach(cleanup);

const longCategory =
  "Change map columns, resizing, and the wrapping of very long labels";
const longChange =
  "Replace the fixed Tailwind column widths with draggable pixel widths";
const longPath =
  "web/src/components/pr-change-map-dialog-with-a-very-long-name.tsx";

const file: PullFile = {
  filename: longPath,
  status: "modified",
  additions: 12,
  deletions: 3,
  patch: "@@ -1 +1 @@\n-const x = 0;\n+const x = 1;",
};

const changeMap: PrChangeMap = {
  head_sha: "a".repeat(40),
  created_by: null,
  created_at: new Date(0).toISOString(),
  document: {
    version: 1,
    summary: "Columns wrap and can be resized.",
    categories: [
      {
        name: longCategory,
        summary: "The columns of the change map dialog.",
        changes: [
          {
            name: longChange,
            kind: "UI component",
            summary: "Widths live in component state.",
            files: [{ path: longPath }],
          },
        ],
      },
    ],
  },
};

function renderDialog() {
  // The dialog renders the map's prose through the shared Markdown component, which queries.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PrChangeMapDialog
        changeMap={changeMap}
        files={[file]}
        headSha={changeMap.head_sha}
        onOpenFile={() => {}}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

function column(label: string): HTMLElement {
  const header = screen.getByText(label);
  const pane = header.closest("div.flex-col");
  if (!(pane instanceof HTMLElement)) throw new Error(`no ${label} column`);
  return pane;
}

function drag(label: string, dx: number) {
  const handle = screen.getByRole("separator", {
    name: `Resize ${label} column`,
  });
  fireEvent.pointerDown(handle, { clientX: 100 });
  fireEvent.pointerMove(window, { clientX: 100 + dx });
  fireEvent.pointerUp(window);
}

describe("PrChangeMapDialog", () => {
  it("wraps long labels instead of truncating them", () => {
    renderDialog();
    const labels = [
      within(column("Category")).getByText(longCategory),
      within(column("Change")).getByText(longChange),
      within(column("File")).getByText(longPath),
    ];
    for (const label of labels) {
      expect(label.className).not.toContain("truncate");
    }
  });

  it("resizes a column by dragging its right edge", () => {
    renderDialog();
    expect(column("Category").style.width).toBe("224px");
    drag("Category", 60);
    expect(column("Category").style.width).toBe("284px");

    drag("Change", -40);
    expect(column("Change").style.width).toBe("216px");

    drag("File", 100);
    expect(column("File").style.width).toBe("420px");
  });

  it("stops shrinking a column at the minimum width", () => {
    renderDialog();
    drag("Category", -500);
    expect(column("Category").style.width).toBe("160px");
  });

  it("starts from the default widths when reopened", () => {
    const { unmount } = renderDialog();
    drag("Category", 60);
    expect(column("Category").style.width).toBe("284px");
    unmount();

    renderDialog();
    expect(column("Category").style.width).toBe("224px");
  });
});
