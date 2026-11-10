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
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
import type { LostPullTerminal, PullTerminal } from "@/api/types";
import { queryKeys } from "@/queries/keys";
import { PullTerminalDock } from "./pull-terminal-dock";

const TERMINALS: PullTerminal[] = [
  { address: "t1", label: "orchestrator", status: "working", closable: false },
  { address: "t2", label: "executor #1", status: "done", closable: false },
  { address: "t3", label: "verifier #1", status: "blocked", closable: false },
  { address: "t4", label: "executor #2", status: "error", closable: false },
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

function renderDock(
  backend = "herdr-core",
  terminals = TERMINALS,
  handlers: Parameters<typeof mockRpcFetch>[0] = {},
) {
  fetchMock = mockRpcFetch({
    "repos/get": () => ({ terminal_backend: backend }),
    "terminal/pullTerminals": () => ({ terminals }),
    ...handlers,
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

function findToggle() {
  return screen.findByRole("button", { name: "Toggle terminal dock" });
}

async function openDock() {
  fireEvent.click(await findToggle());
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

it("starts closed listing every agent without attaching, and opening attaches the leftmost", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  renderDock();
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("false");
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    "orchestratorworking",
    "executor #1idle",
    "verifier #1blocked",
    "executor #2error",
  ]);
  expect(selectedTab()).toBeUndefined();
  expect(screen.queryByText("Terminals")).toBeNull();
  expect(urls).toEqual([]);

  await openDock();
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("true");
  expect(selectedTab()).toBe(tabs[0]);
  await waitFor(() => expect(urls.length).toBe(1));
  const url = new URL(urls[0]);
  expect(url.pathname).toBe("/ws/terminal");
  expect(url.searchParams.get("repo")).toBe("me/proj");
  expect(url.searchParams.get("pull")).toBe("7");
  expect(url.searchParams.get("terminal")).toBe("t1");
});

it("opens no taller than 80% of a short window", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
  try {
    Object.defineProperty(window, "innerHeight", {
      value: 700,
      configurable: true,
    });
    stubWebSocket();
    stubResizeObserver();
    renderDock();
    await openDock();
    const separator = screen.getByRole("separator", {
      name: "Resize terminal dock",
    });
    expect(separator.getAttribute("aria-valuenow")).toBe("560");
  } finally {
    if (descriptor) Object.defineProperty(window, "innerHeight", descriptor);
  }
});

it("opens on the clicked tab of a closed dock and takes the keyboard", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  renderDock();
  fireEvent.click(await screen.findByRole("tab", { name: /executor #1/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("true");
  expect(selectedTab()?.textContent).toBe("executor #1idle");
  await waitFor(() => expect(urls.map(attachedTerminal)).toEqual(["t2"]));
  await waitFor(() => expect(terminalHasFocus()).toBe(true));
});

it("keeps the tabs when the toggle closes the dock", async () => {
  stubWebSocket();
  stubResizeObserver();
  renderDock();
  await openDock();
  await screen.findAllByRole("tab");
  expect(selectedTab()).toBeTruthy();

  fireEvent.click(await findToggle());
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByRole("tab").length).toBe(TERMINALS.length);
  expect(selectedTab()).toBeUndefined();
  expect(document.querySelector(".xterm")).toBeNull();
});

it("closes the dock when the shown tab is clicked, keeping every tab, and switches on another tab", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  renderDock();
  const tablist = await openDock();
  const shown = within(tablist).getByRole("tab", { name: /orchestrator/ });
  await waitFor(() => expect(selectedTab()).toBe(shown));

  fireEvent.click(within(tablist).getByRole("tab", { name: /executor #1/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("true");
  expect(selectedTab()?.textContent).toBe("executor #1idle");

  fireEvent.click(within(tablist).getByRole("tab", { name: /executor #1/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByRole("tab").length).toBe(TERMINALS.length);
  expect(selectedTab()).toBeUndefined();
  expect(document.querySelector(".xterm")).toBeNull();
  expect(
    fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)).method)
      .filter((method) => method.startsWith("terminal/close")),
  ).toEqual([]);

  fireEvent.click(screen.getByRole("tab", { name: /executor #1/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("true");
  expect(selectedTab()?.textContent).toBe("executor #1idle");
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t2"));
});

it("renders a done tab's status exactly like a tab without a status", async () => {
  stubWebSocket();
  stubResizeObserver();
  renderDock("herdr-core", [
    { address: "t1", label: "done", status: "done", closable: false },
    { address: "t2", label: "none", status: null, closable: false },
  ]);
  await openDock();
  const [done, none] = (await screen.findAllByRole("tab")).map(
    (tab) => tab.querySelector("span") as HTMLElement,
  );
  expect(done.textContent).toBe("idle");
  expect(none.textContent).toBe("idle");
  expect(done.className).toBe(none.className);
});

it("shows each status as an icon titled with its name, spinning while working", async () => {
  stubWebSocket();
  stubResizeObserver();
  renderDock("herdr-core", TERMINALS);
  await openDock();
  const statuses = (await screen.findAllByRole("tab")).map(
    (tab) => tab.querySelector("span[title]") as HTMLElement,
  );
  expect(statuses.map((s) => s.title)).toEqual([
    "working",
    "idle",
    "blocked",
    "error",
  ]);
  expect(statuses[0].querySelector("svg")?.getAttribute("class")).toContain(
    "animate-spin",
  );
  expect(statuses[1].querySelector("svg")?.getAttribute("class")).not.toContain(
    "animate-spin",
  );
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
      {
        address: "t5",
        label: "verifier #2",
        status: "working",
        closable: false,
      },
    ],
  });
  await screen.findByRole("tab", { name: /verifier #2/ });
  expect(selectedTab()?.textContent).toBe("executor #1idle");
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
  expect(selectedTab()?.textContent).toBe("executor #1idle");
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
  expect(screen.queryByRole("tablist")).toBeNull();
});

it("renders nothing on a remote page", async () => {
  setPageUrl("https://lh.example.com/");
  renderDock();
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
  expect(screen.queryByRole("tablist")).toBeNull();
});

const LOST: LostPullTerminal[] = [
  { session_id: "s-exec", label: "executor #3", restore_blocker: null },
  {
    session_id: "s-codex",
    label: "verifier #2",
    restore_blocker: "Restore is available for Claude Code only",
  },
];

function renderLostDock(restore: () => unknown) {
  let state = { terminals: TERMINALS.slice(0, 1), lost: LOST };
  renderDock("herdr-core", [], {
    "terminal/pullTerminals": () => state,
    "terminal/restorePullTerminal": () => {
      const result = restore();
      state = {
        terminals: [
          ...state.terminals,
          {
            address: "t9",
            label: "executor #3",
            status: null,
            closable: false,
          },
        ],
        lost: LOST.slice(1),
      };
      return result;
    },
  });
}

it("lists a lost agent as an inactive tab that restores its session", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  renderLostDock(() => ({ backend: "herdr-core", address: "t9" }));
  const tablist = await openDock();
  await waitFor(() =>
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual([
      "orchestratorworking",
      "executor #3inactive",
      "verifier #2inactive",
    ]),
  );
  fireEvent.click(within(tablist).getByRole("tab", { name: /verifier #2/ }));
  expect(
    await screen.findByText("Restore is available for Claude Code only"),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();

  fireEvent.click(within(tablist).getByRole("tab", { name: /executor #3/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(selectedTab()?.textContent).toBe("executor #3idle"),
  );
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t9"));
  const restoreCall = fetchMock.mock.calls
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    .find((body) => body.method === "terminal/restorePullTerminal");
  expect(restoreCall.params).toEqual({
    repo: "me/proj",
    pull: 7,
    sessionId: "s-exec",
  });
});

it("closes the dock when the shown inactive tab is clicked, and switches between tabs", async () => {
  stubWebSocket();
  stubResizeObserver();
  renderLostDock(() => ({ backend: "herdr-core", address: "t9" }));
  const tablist = await openDock();
  const message = "Restore is available for Claude Code only";
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /verifier #2/ }),
  );
  expect(await screen.findByText(message)).toBeTruthy();

  fireEvent.click(within(tablist).getByRole("tab", { name: /verifier #2/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText(message)).toBeNull();
  expect(selectedTab()).toBeUndefined();

  fireEvent.click(within(tablist).getByRole("tab", { name: /verifier #2/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("true");
  expect(await screen.findByText(message)).toBeTruthy();

  fireEvent.click(within(tablist).getByRole("tab", { name: /executor #3/ }));
  expect((await findToggle()).getAttribute("aria-expanded")).toBe("true");
  expect(selectedTab()?.textContent).toBe("executor #3inactive");
});

it("shows why a restore failed", async () => {
  stubWebSocket();
  stubResizeObserver();
  renderLostDock(() => {
    throw new RpcFault(422, "The conversation is no longer saved");
  });
  const tablist = await openDock();
  fireEvent.click(
    await within(tablist).findByRole("tab", { name: /executor #3/ }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The conversation is no longer saved",
  );
});

it("opens a new shell terminal as a selected tab", async () => {
  const urls = stubWebSocket();
  stubResizeObserver();
  let terminals = TERMINALS.slice(0, 1);
  renderDock("herdr-core", [], {
    "terminal/pullTerminals": () => ({
      terminals,
      lost: [],
      shell_blocker: null,
    }),
    "terminal/openPullShell": () => {
      terminals = [
        ...terminals,
        { address: "t8", label: "shell 1", status: null, closable: true },
      ];
      return { backend: "herdr-core", address: "t8" };
    },
  });
  const button = await screen.findByRole("button", { name: "New terminal" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(selectedTab()?.textContent).toBe("shell 1idle"));
  await waitFor(() => expect(urls.map(attachedTerminal).at(-1)).toBe("t8"));
  const call = fetchMock.mock.calls
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    .find((body) => body.method === "terminal/openPullShell");
  expect(call.params).toEqual({ repo: "me/proj", pull: 7 });
});

it("can't open a shell without a worktree and says why", async () => {
  renderDock("herdr-core", [], {
    "terminal/pullTerminals": () => ({
      terminals: [],
      lost: [],
      shell_blocker: "This pull request has no worktree",
    }),
  });
  const button = await screen.findByRole("button", { name: "New terminal" });
  await waitFor(() =>
    expect(button.parentElement?.getAttribute("title")).toBe(
      "This pull request has no worktree",
    ),
  );
  expect(button.hasAttribute("disabled")).toBe(true);
});

it("closes a shell with one click, while the agents' tabs have no close button", async () => {
  stubWebSocket();
  stubResizeObserver();
  let terminals: PullTerminal[] = [
    ...TERMINALS.slice(0, 1),
    { address: "t8", label: "shell 1", status: null, closable: true },
  ];
  renderDock("herdr-core", [], {
    "terminal/pullTerminals": () => ({
      terminals,
      lost: [],
      shell_blocker: null,
    }),
    "terminal/closePullShell": (params: { address: string }) => {
      terminals = terminals.filter((t) => t.address !== params.address);
      return { ok: true };
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Close shell 1" }));
  expect(
    screen.queryByRole("button", { name: "Close orchestrator" }),
  ).toBeNull();
  const call = await waitFor(() => {
    const found = fetchMock.mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
      .find((body) => body.method === "terminal/closePullShell");
    expect(found).toBeTruthy();
    return found;
  });
  expect(call.params).toEqual({ repo: "me/proj", pull: 7, address: "t8" });
});
