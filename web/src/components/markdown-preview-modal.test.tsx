import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
import { MarkdownPreviewModal } from "./markdown-preview-modal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderModal(handlers: Parameters<typeof mockRpcFetch>[0]) {
  vi.stubGlobal("fetch", mockRpcFetch(handlers));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MarkdownPreviewModal
        owner="me"
        repo="proj"
        number={30}
        path="README.md"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("MarkdownPreviewModal", () => {
  it("renders the head Markdown by default and switches to base on toggle", async () => {
    renderModal({
      "pulls/fileAtRef": (p) =>
        p.side === "base"
          ? { status: "ok", content: "# base heading\n" }
          : { status: "ok", content: "# head heading\n" },
    });

    expect(
      await screen.findByRole("heading", { name: "head heading" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Base" }));
    expect(
      await screen.findByRole("heading", { name: "base heading" }),
    ).toBeTruthy();
  });

  it("shows N/A for a missing side and for binary content", async () => {
    renderModal({
      "pulls/fileAtRef": (p) =>
        p.side === "base" ? { status: "missing" } : { status: "binary" },
    });

    expect(
      await screen.findByText("N/A — binary file, cannot render as Markdown."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Base" }));
    expect(
      await screen.findByText("N/A — file does not exist on base."),
    ).toBeTruthy();
  });

  it("surfaces a fetch failure and closes via Escape / the close button", async () => {
    const { onClose } = renderModal({
      "pulls/fileAtRef": () => {
        throw new RpcFault(500, "boom");
      },
    });

    expect(await screen.findByText(/Failed to load preview\./)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
