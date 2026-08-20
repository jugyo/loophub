import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRefKind } from "@/api/types";

// MermaidDiagram itself is covered by mermaid-diagram.test.tsx; here we only need to confirm
// markdown.tsx routes ```mermaid fenced blocks to it (and nowhere else) with the right chart text.
vi.mock("@/components/mermaid-diagram", () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => (
    <div data-testid="mermaid-mock">{chart}</div>
  ),
}));

// The kinds of the references in the body come from the server. Tests set `refKinds` to
// pick what came back; the default (empty) is also the state while the lookup is in flight,
// where a reference stays plain text.
const { refKinds } = vi.hoisted(() => ({
  refKinds: { value: [] as IssueRefKind[] },
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  listIssueRefKinds: vi.fn(async () => refKinds.value),
}));

import { Markdown } from "./markdown";

beforeEach(() => {
  refKinds.value = [];
});

// The `#n` kind lookup is a TanStack Query, so every <Markdown> needs a client.
function renderWithClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// Render `children` inside a memory router so the in-repo `#n` links emitted by
// <Markdown> (TanStack <Link>) can resolve their hrefs against a route tree.
// RouterProvider mounts asynchronously, so wait for <Markdown>'s wrapper before
// returning so callers can query the rendered output synchronously.
async function renderInRouter(children: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{children}</>,
  });
  // A ref link targets the canonical issue or pull route; register both so Link can
  // build hrefs.
  const refRoutes = [
    "/r/$owner/$repo/issues/$number",
    "/r/$owner/$repo/pulls/$number",
  ].map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, ...refRoutes]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const utils = renderWithClient(<RouterProvider router={router} />);
  await waitFor(() =>
    expect(utils.container.querySelector(".markdown-body")).not.toBeNull(),
  );
  return utils;
}

describe("Markdown", () => {
  it("keeps the default rendered DOM unchanged when mapping is omitted", () => {
    const { container } = renderWithClient(
      <Markdown>{"# Heading\n\nParagraph"}</Markdown>,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("p")?.textContent).toBe("Paragraph");
    expect(container.querySelectorAll("[data-source-range]")).toHaveLength(0);
  });

  it("renders headings, emphasis and links", () => {
    const { container } = renderWithClient(
      <Markdown>
        {"# Title\n\n**bold** _italic_ ~~struck~~ [link](https://example.com)"}
      </Markdown>,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("del")?.textContent).toBe("struck");
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
  });

  it("renders fenced code blocks", () => {
    const { container } = renderWithClient(
      <Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>,
    );
    const pre = container.querySelector("pre code");
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("routes a ```mermaid fenced block to MermaidDiagram instead of a plain pre/code", () => {
    const { container } = renderWithClient(
      <Markdown>{"```mermaid\ngraph TD;\nA-->B;\n```"}</Markdown>,
    );
    const mock = container.querySelector('[data-testid="mermaid-mock"]');
    expect(mock?.textContent).toBe("graph TD;\nA-->B;");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("renders GFM tables", () => {
    const { container } = renderWithClient(
      <Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>,
    );
    expect(container.querySelectorAll("table th")).toHaveLength(2);
    expect(container.querySelectorAll("table td")).toHaveLength(2);
  });

  it("renders GFM task lists with checkboxes", () => {
    const { container } = renderWithClient(
      <Markdown>{"- [x] done\n- [ ] todo"}</Markdown>,
    );
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    // checkboxes are disabled (display only, no editing)
    expect(boxes[0].disabled).toBe(true);
  });

  it("escapes embedded raw HTML instead of rendering it (XSS-safe)", () => {
    const { container } = renderWithClient(
      <Markdown>
        {'<img src=x onerror="alert(1)"> <script>alert(1)</script>'}
      </Markdown>,
    );
    // No raw HTML is injected: the markup is escaped, so no <img>/<script> nodes.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // The source appears as visible text.
    expect(container.textContent).toContain("alert(1)");
  });
});

describe("Markdown #n references", () => {
  it("links #n to the canonical issue route when the number is an issue", async () => {
    refKinds.value = [{ repo: "me/proj", number: 123, kind: "issue" }];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"See #123 for details."}
      </Markdown>,
    );
    await waitFor(() =>
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        "/r/me/proj/issues/123",
      ),
    );
    expect(container.querySelector("a")?.textContent).toBe("#123");
  });

  it("links #n to the canonical pull route when the number is a pull", async () => {
    refKinds.value = [{ repo: "me/proj", number: 123, kind: "pull" }];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"See #123 for details."}
      </Markdown>,
    );
    await waitFor(() =>
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        "/r/me/proj/pulls/123",
      ),
    );
  });

  it("links issue and pull refs in one body to their own routes", async () => {
    refKinds.value = [
      { repo: "me/proj", number: 1, kind: "issue" },
      { repo: "me/proj", number: 2, kind: "pull" },
    ];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"#1 then #2"}
      </Markdown>,
    );
    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll("a")).map((a) =>
          a.getAttribute("href"),
        ),
      ).toEqual(["/r/me/proj/issues/1", "/r/me/proj/pulls/2"]),
    );
  });

  it("leaves a number with no Issue or PR as plain text", async () => {
    refKinds.value = [];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"See #123 for details."}
      </Markdown>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("See #123 for details.");
  });

  it("links only the refs whose kind is known, keeping the rest as text", async () => {
    refKinds.value = [{ repo: "me/proj", number: 2, kind: "pull" }];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"#1 then #2"}
      </Markdown>,
    );
    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll("a")).map((a) => ({
          href: a.getAttribute("href"),
          text: a.textContent,
        })),
      ).toEqual([{ href: "/r/me/proj/pulls/2", text: "#2" }]),
    );
    expect(container.textContent).toContain("#1 then");
  });

  it("only linkifies Issue and PR ids when generated ids are mixed in", async () => {
    refKinds.value = [
      { repo: "me/proj", number: 42, kind: "issue" },
      { repo: "me/proj", number: 43, kind: "pull" },
    ];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {
          "Issue #42, workflow run 7, review 12, PR #43, comment 19, and event 3."
        }
      </Markdown>,
    );
    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll("a")).map((anchor) => ({
          href: anchor.getAttribute("href"),
          text: anchor.textContent,
        })),
      ).toEqual([
        { href: "/r/me/proj/issues/42", text: "#42" },
        { href: "/r/me/proj/pulls/43", text: "#43" },
      ]),
    );
    expect(container.textContent).toContain(
      "workflow run 7, review 12, PR #43, comment 19, and event 3",
    );
  });

  it("does not linkify when owner/repo are absent", () => {
    const { container } = renderWithClient(<Markdown>{"See #123."}</Markdown>);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("#123");
  });

  it("does not linkify #n inside inline or fenced code", async () => {
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"inline `#5` and\n\n```\nblock #6\n```"}
      </Markdown>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toContain("#5");
  });

  it("does not linkify hex colors, entities, or non-ref hashes", async () => {
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"color #fff and #abc123 plain"}
      </Markdown>,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("does not linkify #n in headings", async () => {
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"## Heading #5"}
      </Markdown>,
    );
    expect(container.querySelector("h2")?.textContent).toContain("#5");
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders a body link with a ref-shaped href without crashing", async () => {
    // A hand-authored link whose href matches the ref shape must render without
    // tearing down the tree. react-markdown normalizes URL encoding before the
    // anchor renderer runs, and refParams() guards decodeURIComponent anyway.
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"[x](/r/%/y/issues/1)"}
      </Markdown>,
    );
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("x");
  });

  it("does not nest a ref link inside a reference-style link", async () => {
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"[see #5][ref]\n\n[ref]: https://example.com"}
      </Markdown>,
    );
    const anchors = Array.from(container.querySelectorAll("a"));
    // Only the reference link itself; `#5` in its text stays plain (no nested <a>).
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute("href")).toBe("https://example.com");
    expect(anchors[0].textContent).toContain("#5");
  });

  it("links owner/repo#n to the referenced repo's canonical route", async () => {
    refKinds.value = [{ repo: "other/lib", number: 7, kind: "issue" }];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"See other/lib#7 for details."}
      </Markdown>,
    );
    await waitFor(() =>
      expect(container.querySelector("a")?.getAttribute("href")).toBe(
        "/r/other/lib/issues/7",
      ),
    );
    expect(container.querySelector("a")?.textContent).toBe("other/lib#7");
  });

  it("keeps a cross-repo reference plain when the repo is not hosted here", async () => {
    refKinds.value = [];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"See other/lib#7 for details."}
      </Markdown>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("See other/lib#7 for details.");
  });

  it("does not linkify a repo-shaped path inside a URL", async () => {
    refKinds.value = [{ repo: "other/lib", number: 7, kind: "issue" }];
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"see <https://github.com/other/lib#7> now"}
      </Markdown>,
    );
    // The autolink itself, and no ref link nested in or beside it.
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://github.com/other/lib#7",
    ]);
  });

  it("preserves the title attribute on non-ref links", () => {
    const { container } = renderWithClient(
      <Markdown owner="me" repo="proj">
        {'[x](https://example.com "tip")'}
      </Markdown>,
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.getAttribute("title")).toBe("tip");
  });
});

describe("Markdown image lightbox", () => {
  it("opens a lightbox dialog when an embedded image is clicked", () => {
    const { container } = renderWithClient(
      <Markdown>{"![alt text](https://example.com/pic.png)"}</Markdown>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    const img = container.querySelector(".markdown-body img");
    expect(img?.getAttribute("src")).toBe("https://example.com/pic.png");
    fireEvent.click(img as Element);

    const dialog = screen.queryByRole("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/pic.png",
    );
  });

  it("closes the lightbox on backdrop click and on Escape", () => {
    const { container } = renderWithClient(
      <Markdown>{"![alt text](https://example.com/pic.png)"}</Markdown>,
    );
    fireEvent.click(container.querySelector(".markdown-body img") as Element);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(container.querySelector(".markdown-body img") as Element);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the lightbox via keyboard (Enter/Space) as well as click", () => {
    const { container } = renderWithClient(
      <Markdown>{"![alt text](https://example.com/pic.png)"}</Markdown>,
    );
    const img = container.querySelector(".markdown-body img") as Element;
    fireEvent.keyDown(img, { key: "Enter" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("preserves the title attribute on embedded images", () => {
    const { container } = renderWithClient(
      <Markdown>
        {'![alt text](https://example.com/pic.png "a caption")'}
      </Markdown>,
    );
    const img = container.querySelector(".markdown-body img");
    expect(img?.getAttribute("title")).toBe("a caption");
  });
});
