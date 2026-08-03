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
      "pulls/archive": () => ({ ok: true }),
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

  it("confirms archiving and calls the PR archive RPC", async () => {
    const onArchived = vi.fn();
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
          onArchived={onArchived}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /PR actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Archive$/i }));
    expect(
      screen.getByRole("dialog", { name: /Archive PR #30/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/i }));

    await waitFor(() => expect(rpcCall("pulls/archive")).toBeTruthy());
    expect(rpcCall("pulls/archive")!.params).toMatchObject({
      repo: "me/proj",
      number: 30,
    });
    expect(onArchived).toHaveBeenCalledOnce();
  });
});
