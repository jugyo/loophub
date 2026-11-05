import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "#loophub-test";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { PullTerminal } from "@/api/types";
import { queryKeys } from "@/queries/keys";
import { PullTerminalDock } from "./pull-terminal-dock";

const TERMINALS: PullTerminal[] = [
  { address: "t1", label: "orchestrator", status: "working" },
  { address: "t2", label: "executor #1", status: "done" },
  { address: "t3", label: "verifier #1", status: "blocked" },
  { address: "t4", label: "executor #2", status: "error" },
];

let fetchMock: ReturnType<typeof mockRpcFetch>;

beforeEach(() => setPageUrl("http://localhost:8730/"));

afterEach(() => {
  setPageUrl("about:blank");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setPageUrl(url: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);
}

function renderDock(backend = "herdr-core", terminals = TERMINALS) {
  fetchMock = mockRpcFetch({
    "repos/get": () => ({ terminal_backend: backend }),
    "terminal/pullTerminals": () => ({ terminals }),
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <PullTerminalDock owner="me" repo="proj" number={7} />
    </QueryClientProvider>,
  );
  return client;
}

function stubWebSocket(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      send() {}
      close() {}
      constructor(url: string) {
        urls.push(url);
      }
    },
  );
  return urls;
}

async function openDock() {
  fireEvent.click(await screen.findByRole("button", { name: /Terminals/ }));
  return screen.findByRole("tablist");
}

it("starts closed, and opening lists every agent with its status without attaching", async () => {
  const urls = stubWebSocket();
  renderDock();
  expect(
    (await screen.findByRole("button", { name: /Terminals/ })).getAttribute(
      "aria-expanded",
    ),
  ).toBe("false");
  expect(screen.queryByRole("tab")).toBeNull();

  await openDock();
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "orchestratorworking",
    "executor #1done",
    "verifier #1blocked",
    "executor #2error",
  ]);
  expect(urls).toEqual([]);
  expect(screen.getByText("Select a terminal to attach.")).toBeTruthy();
});

it("attaches the selected tab through the relay", async () => {
  const urls = stubWebSocket();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  renderDock();
  const tablist = await openDock();
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /executor #1/ }),
  );
  await waitFor(() => expect(urls.length).toBe(1));
  const url = new URL(urls[0]);
  expect(url.pathname).toBe("/ws/terminal");
  expect(url.searchParams.get("repo")).toBe("me/proj");
  expect(url.searchParams.get("pull")).toBe("7");
  expect(url.searchParams.get("terminal")).toBe("t2");
});

it("drops a finished terminal's tab and view", async () => {
  stubWebSocket();
  const client = renderDock();
  const tablist = await openDock();
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /executor #1/ }),
  );
  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS.filter((terminal) => terminal.address !== "t2"),
  });
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: /executor #1/ })).toBeNull(),
  );
  expect(screen.getByText("Select a terminal to attach.")).toBeTruthy();
});

it("renders nothing on a herdr repo", async () => {
  renderDock("herdr");
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("button", { name: /Terminals/ })).toBeNull();
});

it("renders nothing on a remote page", async () => {
  setPageUrl("https://lh.example.com/");
  renderDock();
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("button", { name: /Terminals/ })).toBeNull();
});
