import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

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
  // The ref link targets the resolver route; register it so Link can build href.
  const refRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/n/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, refRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const utils = render(<RouterProvider router={router} />);
  await waitFor(() =>
    expect(utils.container.querySelector(".markdown-body")).not.toBeNull(),
  );
  return utils;
}

describe("Markdown", () => {
  it("renders headings, emphasis and links", () => {
    const { container } = render(
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
    const { container } = render(
      <Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>,
    );
    const pre = container.querySelector("pre code");
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("renders GFM tables", () => {
    const { container } = render(
      <Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>,
    );
    expect(container.querySelectorAll("table th")).toHaveLength(2);
    expect(container.querySelectorAll("table td")).toHaveLength(2);
  });

  it("renders GFM task lists with checkboxes", () => {
    const { container } = render(
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
    const { container } = render(
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
  it("linkifies #n in body text to the in-repo resolver route", async () => {
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"See #123 for details."}
      </Markdown>,
    );
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/r/me/proj/n/123");
    expect(a?.textContent).toBe("#123");
  });

  it("linkifies multiple refs and leaves surrounding text intact", async () => {
    const { container } = await renderInRouter(
      <Markdown owner="me" repo="proj">
        {"#1 then #2"}
      </Markdown>,
    );
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/r/me/proj/n/1", "/r/me/proj/n/2"]);
    expect(container.textContent).toContain("then");
  });

  it("does not linkify when owner/repo are absent", () => {
    const { container } = render(<Markdown>{"See #123."}</Markdown>);
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
        {"[x](/r/%/y/n/1)"}
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

  it("preserves the title attribute on non-ref links", () => {
    const { container } = render(
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
    const { container } = render(
      <Markdown>{"![alt text](https://example.com/pic.png)"}</Markdown>,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    const img = container.querySelector(".markdown-body img");
    expect(img?.getAttribute("src")).toBe("https://example.com/pic.png");
    fireEvent.click(img as Element);

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/pic.png",
    );
  });

  it("closes the lightbox on backdrop click and on Escape", () => {
    const { container } = render(
      <Markdown>{"![alt text](https://example.com/pic.png)"}</Markdown>,
    );
    fireEvent.click(container.querySelector(".markdown-body img") as Element);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    fireEvent.click(container.querySelector('[role="dialog"]') as Element);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    fireEvent.click(container.querySelector(".markdown-body img") as Element);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    fireEvent.keyDown(container.querySelector('[role="dialog"]') as Element, {
      key: "Escape",
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the lightbox via keyboard (Enter/Space) as well as click", () => {
    const { container } = render(
      <Markdown>{"![alt text](https://example.com/pic.png)"}</Markdown>,
    );
    const img = container.querySelector(".markdown-body img") as Element;
    fireEvent.keyDown(img, { key: "Enter" });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("preserves the title attribute on embedded images", () => {
    const { container } = render(
      <Markdown>
        {'![alt text](https://example.com/pic.png "a caption")'}
      </Markdown>,
    );
    const img = container.querySelector(".markdown-body img");
    expect(img?.getAttribute("title")).toBe("a caption");
  });
});
