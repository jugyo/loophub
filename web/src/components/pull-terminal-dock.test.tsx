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

function stubResizeObserver() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
}

function selectedTab() {
  return screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true");
}

function attachedTerminal(url: string) {
  return new URL(url).searchParams.get("terminal");
}

it("starts closed without attaching, and opening lists every agent and attaches the leftmost", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  renderDock();
  expect(
    (await screen.findByRole("button", { name: /Terminals/ })).getAttribute(
      "aria-expanded",
    ),
  ).toBe("false");
  expect(screen.queryByRole("tab")).toBeNull();
  expect(urls).toEqual([]);

  await openDock();
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "orchestratorworking",
    "executor #1done",
    "verifier #1blocked",
    "executor #2error",
  ]);
  expect(selectedTab()).toBe(tabs[0]);
  await waitFor(() => expect(urls.length).toBe(1));
  const url = new URL(urls[0]);
  expect(url.pathname).toBe("/ws/terminal");
  expect(url.searchParams.get("repo")).toBe("me/proj");
  expect(url.searchParams.get("pull")).toBe("7");
  expect(url.searchParams.get("terminal")).toBe("t1");
});

it("selects the leftmost tab once tabs appear in an open dock", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  const client = renderDock("herdr-core", []);
  await openDock();
  expect(await screen.findByText("No live agent terminals.")).toBeTruthy();
  expect(urls).toEqual([]);

  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS,
  });
  await screen.findAllByRole("tab");
  expect(selectedTab()?.textContent).toBe("orchestratorworking");
  await waitFor(() => expect(urls.map(attachedTerminal)).toEqual(["t1"]));
});

it("selects the leftmost remaining tab when the selected terminal finishes", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
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
  expect(selectedTab()?.textContent).toBe("orchestratorworking");
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t1"));
});

it("keeps the user's tab when the list updates", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  const client = renderDock();
  const tablist = await openDock();
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /executor #1/ }),
  );
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t2"));
  const attaches = urls.length;

  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: [
      ...TERMINALS.filter((terminal) => terminal.address !== "t1"),
      { address: "t5", label: "verifier #2", status: "working" },
    ],
  });
  await screen.findByRole("tab", { name: /verifier #2/ });
  expect(selectedTab()?.textContent).toBe("executor #1done");
  expect(urls.length).toBe(attaches);
});

it("moves on to the next tab when the leftmost tab shown by default finishes", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  const client = renderDock();
  await openDock();
  await waitFor(() => expect(urls.map(attachedTerminal)).toEqual(["t1"]));

  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS.filter((terminal) => terminal.address !== "t1"),
  });
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t2"));
  expect(selectedTab()?.textContent).toBe("executor #1done");
});

it("stays on the current tab when a finished terminal is listed again", async () => {
  stubWebSocket();
  stubResizeObserver();
  const client = renderDock();
  const tablist = await openDock();
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /executor #1/ }),
  );
  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS.filter((terminal) => terminal.address !== "t2"),
  });
  await waitFor(() =>
    expect(selectedTab()?.textContent).toBe("orchestratorworking"),
  );

  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS,
  });
  await screen.findByRole("tab", { name: /executor #1/ });
  expect(selectedTab()?.textContent).toBe("orchestratorworking");
});

function focusPageInput() {
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  return input;
}

function terminalHasFocus() {
  return document.activeElement?.classList.contains("xterm-helper-textarea");
}

it("takes the keyboard when a tab is clicked", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  renderDock();
  const tablist = await openDock();
  await waitFor(() => expect(urls.map(attachedTerminal)).toEqual(["t1"]));
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /executor #1/ }),
  );
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t2"));
  await waitFor(() => expect(terminalHasFocus()).toBe(true));
});

it("leaves the keyboard alone when opening or a list update attaches a tab", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  const client = renderDock("herdr-core", []);
  const input = focusPageInput();
  await openDock();
  expect(await screen.findByText("No live agent terminals.")).toBeTruthy();

  // A tab appears in the open dock.
  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS,
  });
  await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());
  await waitFor(() => expect(urls.map(attachedTerminal)).toEqual(["t1"]));
  expect(document.activeElement).toBe(input);

  // The shown terminal finishes, and the dock moves on to the next one.
  client.setQueryData(queryKeys.pullTerminals("me/proj", 7), {
    terminals: TERMINALS.filter((terminal) => terminal.address !== "t1"),
  });
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t2"));
  await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());
  expect(document.activeElement).toBe(input);
  input.remove();
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
