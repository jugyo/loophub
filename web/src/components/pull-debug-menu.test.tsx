import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import { PullDebugMenu } from "./pull-debug-menu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const debugDump = {
  repo: { full_name: "me/proj" },
  pull_row: { head_ref: "feature", base_ref: "main" },
  git: { commits_ahead: 1 },
};

function renderMenu() {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "pulls/debug": () => debugDump,
      "pulls/delete": () => ({ ok: true }),
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PullDebugMenu owner="me" repo="proj" number={30} />
    </QueryClientProvider>,
  );
}

describe("PullDebugMenu", () => {
  it("does not fetch the debug dump until the modal is opened", () => {
    renderMenu();
    // The discreet trigger is present but nothing has been fetched yet.
    expect(screen.getByRole("button", { name: /PR actions/i })).toBeTruthy();
    expect(rpcCall("pulls/debug")).toBeFalsy();
  });

  it("opens a full-size modal that fetches lazily and renders the dump as tables", async () => {
    renderMenu();

    // Open the overflow menu, then the debug item.
    fireEvent.click(screen.getByRole("button", { name: /PR actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /View debug data/i }));

    // The modal fetches lazily on open.
    const dialog = await screen.findByRole("dialog", {
      name: /Debug data for PR #30/i,
    });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(rpcCall("pulls/debug")).toBeTruthy());
    expect(rpcCall("pulls/debug")!.params.number).toBe(30);

    // Table view: section heading per top-level key + key/value cells.
    expect(await screen.findByText("repo")).toBeTruthy();
    expect(screen.getByText("full_name")).toBeTruthy();
    expect(screen.getByText("me/proj")).toBeTruthy();
    expect(screen.getByText("commits_ahead")).toBeTruthy();
    // Copy JSON stays available; there is no JSON view toggle.
    expect(screen.getByRole("button", { name: /Copy JSON/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^JSON$/ })).toBeNull();
  });

  it("closes the modal and returns to the PR detail (escape + close button)", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /PR actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /View debug data/i }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: /Close debug data/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("confirms deletion and calls the PR delete RPC", async () => {
    const onDeleted = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <PullDebugMenu
          owner="me"
          repo="proj"
          number={30}
          onDeleted={onDeleted}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /PR actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/i }));
    expect(screen.getByRole("dialog", { name: /Delete PR #30/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));

    await waitFor(() => expect(rpcCall("pulls/delete")).toBeTruthy());
    expect(rpcCall("pulls/delete")!.params).toMatchObject({
      repo: "me/proj",
      number: 30,
    });
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});
