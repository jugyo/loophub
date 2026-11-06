import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "#loophub-test";
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
import type { IssueTerminalHistory, PullTerminal } from "@/api/types";
import { CreateIssueButton } from "@/components/create-issue-button";
import { queryKeys } from "@/queries/keys";
import { IssueTerminalDock } from "./issue-terminal-dock";
import { TerminalControllerProvider } from "./terminal-controller";

const STARTED: PullTerminal = {
  address: "t9",
  label: "New issue 2",
  status: null,
  closable: true,
};
const EARLIER: PullTerminal = {
  address: "t3",
  label: "New issue 1",
  status: "working",
  closable: true,
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

const HISTORY: IssueTerminalHistory[] = [
  {
    session_id: "s-filed",
    runtime: "claude-code",
    issue: { number: 12, title: "Filed earlier" },
    started_at: "2026-11-05T10:00:00Z",
    updated_at: "2026-11-05T11:00:00Z",
    restore_blocker: null,
  },
  {
    session_id: "s-codex",
    runtime: "codex",
    issue: null,
    started_at: "2026-11-04T10:00:00Z",
    updated_at: "2026-11-04T11:00:00Z",
    restore_blocker: "Restore is available for Claude Code only",
  },
];
const RESTORED: PullTerminal = {
  address: "t12",
  label: "New issue 3",
  status: null,
  closable: true,
};

function renderPage(
  backend = "herdr-core",
  {
    restoreFails = false,
    issue,
    live = [EARLIER],
  }: { restoreFails?: boolean; issue?: number; live?: PullTerminal[] } = {},
) {
  let terminals = live;
  const issueParams: unknown[] = [];
  const fetchMock = mockRpcFetch({
    "repos/get": () => ({ terminal_backend: backend }),
    "settings/get": () => ({}),
    "terminal/issueTerminals": (params: { issue?: number }) => {
      issueParams.push(params.issue);
      // An issue's own list: the terminal it was filed from, never the one launched since.
      return { terminals: params.issue ? live : terminals };
    },
    "terminal/issueTerminalHistory": () => ({ sessions: HISTORY }),
    "terminal/closeIssueTerminal": (params: { address: string }) => {
      terminals = terminals.filter((t) => t.address !== params.address);
      return { ok: true };
    },
    "terminal/restoreIssueTerminal": () => {
      if (restoreFails)
        throw new RpcFault(500, "No conversation found with session ID");
      terminals = [EARLIER, RESTORED];
      return { backend: "herdr-core", address: "t12" };
    },
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
        <IssueTerminalDock owner="me" repo="proj" issue={issue} />
      </TerminalControllerProvider>
    </QueryClientProvider>,
  );
  return { client, fetchMock, issueParams };
}

it("opens on the terminal New issue started and attaches without a PR", async () => {
  renderPage();
  await screen.findByRole("tab", { name: /New issue 1/ });
  expect(urls).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "New issue" }));

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
  fireEvent.click(
    await screen.findByRole("button", { name: "Toggle terminal dock" }),
  );
  await screen.findByRole("tab", { name: /New issue 1/ });
  expect(urls).toEqual([]);
  expect(screen.getByText("Select a terminal to attach.")).toBeTruthy();

  client.setQueryData(queryKeys.issueTerminals("me/proj"), { terminals: [] });
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: /New issue 1/ })).toBeNull(),
  );
  expect(screen.getByText("No live agent terminals.")).toBeTruthy();
});

it("opens on the clicked tab of a closed dock", async () => {
  renderPage();
  const tab = await screen.findByRole("tab", { name: /New issue 1/ });
  expect(tab.getAttribute("aria-selected")).toBe("false");

  fireEvent.click(tab);

  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  expect(
    screen
      .getByRole("button", { name: "Toggle terminal dock" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  await waitFor(() => expect(urls.length).toBe(1));
  expect(new URL(urls[0]).searchParams.get("terminal")).toBe("t3");
});

it("renders nothing on a herdr repo", async () => {
  const { fetchMock } = renderPage("herdr");
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("tablist")).toBeNull();
});

it("renders nothing on a remote page", async () => {
  setPageUrl("https://lh.example.com/");
  const { fetchMock } = renderPage();
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("tablist")).toBeNull();
});

it("on an issue's screen, lists that issue's terminals and opens on a New issue launched there", async () => {
  const { issueParams } = renderPage("herdr-core", { issue: 5 });
  await screen.findByRole("tab", { name: /New issue 1/ });
  expect(issueParams).toEqual([5]);

  fireEvent.click(screen.getByRole("button", { name: "New issue" }));

  const tab = await screen.findByRole("tab", { name: /New issue 2/ });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() => expect(urls.length).toBe(1));
  expect(new URL(urls[0]).searchParams.get("terminal")).toBe("t9");
  expect(screen.getByRole("tab", { name: /New issue 1/ })).toBeTruthy();
});

function rpcCalls(fetchMock: ReturnType<typeof mockRpcFetch>, method: string) {
  return fetchMock.mock.calls
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    .filter((body) => body.method === method);
}

it("closes a tab's terminal with one click", async () => {
  const { fetchMock } = renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Close New issue 1" }),
  );
  await waitFor(() =>
    expect(rpcCalls(fetchMock, "terminal/closeIssueTerminal")).toHaveLength(1),
  );
  expect(rpcCalls(fetchMock, "terminal/closeIssueTerminal")[0].params).toEqual({
    repo: "me/proj",
    address: "t3",
  });
});

function terminalHasFocus() {
  return document.activeElement?.classList.contains("xterm-helper-textarea");
}

async function closeShownTab(name: RegExp, closeLabel: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
  await waitFor(() => expect(document.querySelector(".xterm")).toBeTruthy());
  // The keyboard is elsewhere on the page when the tab is closed.
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  fireEvent.click(screen.getByRole("button", { name: closeLabel }));
  return input;
}

it("moves to the right neighbour, with the keyboard, when the shown tab is closed", async () => {
  renderPage("herdr-core", { live: [EARLIER, STARTED, RESTORED] });
  const input = await closeShownTab(/New issue 2/, "Close New issue 2");

  const next = screen.getByRole("tab", { name: /New issue 3/ });
  await waitFor(() => expect(next.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() =>
    expect(new URL(urls.at(-1) as string).searchParams.get("terminal")).toBe(
      "t12",
    ),
  );
  await waitFor(() => expect(terminalHasFocus()).toBe(true));
  input.remove();
});

it("moves to the left neighbour when the shown tab at the right end is closed", async () => {
  renderPage("herdr-core", { live: [EARLIER, STARTED, RESTORED] });
  const input = await closeShownTab(/New issue 3/, "Close New issue 3");

  const next = screen.getByRole("tab", { name: /New issue 2/ });
  await waitFor(() => expect(next.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() =>
    expect(new URL(urls.at(-1) as string).searchParams.get("terminal")).toBe(
      "t9",
    ),
  );
  await waitFor(() => expect(terminalHasFocus()).toBe(true));
  input.remove();
});

it("shows the empty dock when the only tab is closed", async () => {
  renderPage();
  const input = await closeShownTab(/New issue 1/, "Close New issue 1");

  await waitFor(() => expect(document.querySelector(".xterm")).toBeNull());
  expect(screen.getByText("Select a terminal to attach.")).toBeTruthy();
  expect(urls).toHaveLength(1);
  expect(document.activeElement).toBe(input);
  input.remove();
});

it("lists past New issues in the History tab, with why one can't be restored", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  expect(await screen.findByText("#12 Filed earlier")).toBeTruthy();
  expect(screen.getByText(/^Not filed — started/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
  expect(
    screen.getByText("Restore is available for Claude Code only"),
  ).toBeTruthy();
});

it("restores a session and opens the dock on its terminal", async () => {
  const { fetchMock } = renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

  const tab = await screen.findByRole("tab", { name: /New issue 3/ });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  expect(
    rpcCalls(fetchMock, "terminal/restoreIssueTerminal")[0].params,
  ).toEqual({ repo: "me/proj", sessionId: "s-filed" });
  await waitFor(() =>
    expect(new URL(urls.at(-1) as string).searchParams.get("terminal")).toBe(
      "t12",
    ),
  );
});

it("shows why a restore failed", async () => {
  renderPage("herdr-core", { restoreFails: true });
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "No conversation found with session ID",
  );
});

it("on an issue's screen, opens on a session restored there", async () => {
  renderPage("herdr-core", { issue: 5 });
  fireEvent.click(await screen.findByRole("button", { name: "History" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

  const tab = await screen.findByRole("tab", { name: /New issue 3/ });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() =>
    expect(new URL(urls.at(-1) as string).searchParams.get("terminal")).toBe(
      "t12",
    ),
  );
});
