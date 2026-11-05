import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "#loophub-test";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { PullTerminal } from "@/api/types";
import { CreateIssueButton } from "@/components/create-issue-button";
import { queryKeys } from "@/queries/keys";
import { IssueTerminalDock } from "./issue-terminal-dock";
import { TerminalControllerProvider } from "./terminal-controller";

const STARTED: PullTerminal = {
  address: "t9",
  label: "New issue 2",
  status: null,
};
const EARLIER: PullTerminal = {
  address: "t3",
  label: "New issue 1",
  status: "working",
};

let urls: string[];

function setPageUrl(url: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);
}

beforeEach(() => {
  setPageUrl("http://localhost:8730/");
  urls = [];
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  setPageUrl("about:blank");
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPage(backend = "herdr-core") {
  let terminals = [EARLIER];
  const fetchMock = mockRpcFetch({
    "repos/get": () => ({ terminal_backend: backend }),
    "settings/get": () => ({}),
    "terminal/issueTerminals": () => ({ terminals }),
    "terminal/launch": () => {
      // The launch records its terminal before it answers.
      terminals = [EARLIER, STARTED];
      return {
        backend: "herdr-core",
        attach: "hc attach t9",
        address: "t9",
      };
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TerminalControllerProvider>
        <CreateIssueButton repo="me/proj" />
        <IssueTerminalDock owner="me" repo="proj" />
      </TerminalControllerProvider>
    </QueryClientProvider>,
  );
  return { client, fetchMock };
}

it("opens on the terminal New issue started and attaches without a PR", async () => {
  renderPage();
  await screen.findByRole("button", { name: /Terminals/ });
  expect(screen.queryByRole("tab")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /new issue/i }));

  const tab = await screen.findByRole("tab", { name: /New issue 2/ });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() => expect(urls.length).toBe(1));
  const url = new URL(urls[0]);
  expect(url.pathname).toBe("/ws/terminal");
  expect(url.searchParams.get("repo")).toBe("me/proj");
  expect(url.searchParams.get("terminal")).toBe("t9");
  expect(url.searchParams.has("pull")).toBe(false);
});

it("lists live terminals without attaching after a reload, and drops a finished one", async () => {
  const { client } = renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Terminals/ }));
  await screen.findByRole("tab", { name: /New issue 1/ });
  expect(urls).toEqual([]);

  client.setQueryData(queryKeys.issueTerminals("me/proj"), { terminals: [] });
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: /New issue 1/ })).toBeNull(),
  );
  expect(screen.getByText("No live agent terminals.")).toBeTruthy();
});

it("renders nothing on a herdr repo", async () => {
  const { fetchMock } = renderPage("herdr");
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("button", { name: /Terminals/ })).toBeNull();
});

it("renders nothing on a remote page", async () => {
  setPageUrl("https://lh.example.com/");
  const { fetchMock } = renderPage();
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("button", { name: /Terminals/ })).toBeNull();
});
