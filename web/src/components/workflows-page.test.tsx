import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault, rpcCall } from "@/api/rpc-mock";
import type { Workflow } from "@/api/types";
import { WorkflowsPage } from "./workflows-page";

const CONTRACTS = {
  parent: "# Parent workflow contract\nParent contract body",
  execute: "# Execute step contract\nExecute contract body",
  verify: "# Verify step contract\nVerify contract body",
};

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 1,
    name: "standard",
    description: "The default loop",
    execute_prompt: "execute here",
    verify_prompt: "verify here",
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    scope: { kind: "global" },
    ...overrides,
  };
}

function renderPage(
  handlers: Parameters<typeof mockRpcFetch>[0],
  workflows: Workflow[] = [],
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({
      "workflows/list": () => workflows,
      "workflows/contracts": () => CONTRACTS,
      "settings/get": () => ({ workflowContractLanguage: "en" }),
      "terminal/launch": () => ({ backend: "herdr", session_name: "loophub" }),
      ...handlers,
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div data-testid="settings-page" />,
  });
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/workflows",
    component: WorkflowsPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, workflowsRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/workflows"] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

// Open a workflow's edit dialog: the only remaining create/edit form path is edit (#1889).
async function openEditDialog() {
  const editButton = await screen.findByRole("button", { name: "Edit" });
  editButton.focus();
  fireEvent.click(editButton);
  return screen.getByRole("dialog", { name: 'Edit "standard"' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkflowsPage", () => {
  it("shows the settings sidebar and returns to Agent settings", async () => {
    const { router } = renderPage({});

    const navigation = await screen.findByRole("navigation", {
      name: "Settings",
    });
    const workflowsLink = within(navigation).getByRole("link", {
      name: "Workflows",
    });
    const agentLink = within(navigation).getByRole("link", { name: "Agent" });
    expect(workflowsLink.getAttribute("aria-current")).toBe("page");
    expect(agentLink.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();

    fireEvent.click(agentLink);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
    expect(screen.getByTestId("settings-page")).toBeTruthy();
  });

  it("shows the shared settings layout above the workflow management content", async () => {
    renderPage({});

    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeTruthy();
    expect(screen.getByText("Instance-level settings")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Workflows" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Workflows" })).toBeTruthy();
    expect(await screen.findByText("No workflows yet.")).toBeTruthy();
  });

  it("shows and saves the workflow contract language beside the workflow list", async () => {
    renderPage({
      "settings/get": () => ({ workflowContractLanguage: "ja" }),
      "settings/update": () => ({ workflowContractLanguage: "en" }),
    });

    const group = await screen.findByRole("radiogroup", {
      name: "Workflow contract language",
    });
    expect(
      within(group)
        .getByRole("radio", { name: "日本語" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(within(group).getByRole("radio", { name: "English" }));
    await waitFor(() =>
      expect(rpcCall("settings/update")?.params).toMatchObject({
        workflowContractLanguage: "en",
      }),
    );
  });

  it("lists saved workflows with their name and description", async () => {
    renderPage({}, [workflow()]);
    expect(await screen.findByText("standard")).toBeTruthy();
    expect(screen.getByText("The default loop")).toBeTruthy();
  });

  it("shows an empty state when there are no workflows", async () => {
    renderPage({});
    expect(await screen.findByText("No workflows yet.")).toBeTruthy();
  });

  it("launches an AI-driven workflow-create session instead of opening a create form", async () => {
    renderPage({});
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );

    await waitFor(() => expect(rpcCall("terminal/launch")).toBeTruthy());
    const params = rpcCall("terminal/launch")?.params as {
      workflow?: string;
      prompt?: string;
      repo?: string;
    };
    expect(params.workflow).toBe("workflow-create");
    expect(params.prompt).toContain("lh workflow create");
    // The global New workflow launch carries no repo (#1889).
    expect(params.repo).toBeUndefined();
    // No create form dialog opens anymore.
    expect(screen.queryByRole("dialog", { name: "New workflow" })).toBeNull();
  });

  it("passes the configured contract language into the workflow-create prompt", async () => {
    renderPage({
      "settings/get": () => ({ workflowContractLanguage: "ja" }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );

    await waitFor(() => expect(rpcCall("terminal/launch")).toBeTruthy());
    const params = rpcCall("terminal/launch")?.params as { prompt?: string };
    expect(params.prompt).toContain("LoopHub workflow を作成");
  });

  it("edits a workflow in a dialog and refreshes the list", async () => {
    let workflows = [workflow()];
    renderPage({
      "workflows/list": () => workflows,
      "workflows/update": (params) => {
        const updated = workflow({
          ...workflows[0],
          name: params.new_name,
          description: params.description,
        });
        workflows = [updated];
        return updated;
      },
    });

    const dialog = await openEditDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "standard-v2" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    expect(await screen.findByText("standard-v2")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: 'Edit "standard"' }),
    ).toBeNull();
  });

  it("prefills the edit form with the workflow's saved prompts", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    const executeField = within(dialog).getByRole("textbox", {
      name: "Execute prompt",
    }) as HTMLTextAreaElement;
    expect(executeField.value).toBe("execute here");
  });

  it("uses most of the dialog for one large, vertically resizable prompt editor", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();

    expect(dialog.classList).toContain("max-w-7xl");
    expect(
      within(dialog).getByRole("textbox", { name: "Name" }).closest("label")
        ?.parentElement?.classList,
    ).toContain("flex-col");
    const editor = within(dialog).getByRole("textbox", {
      name: "Execute prompt",
    });
    expect(within(dialog).getAllByText("Execute prompt")).toHaveLength(1);
    expect(editor.classList).toContain("min-h-80");
    expect(editor.classList).toContain("flex-1");
    expect(editor.classList).toContain("resize-y");
    expect(
      within(dialog).queryByRole("textbox", { name: "Verify prompt" }),
    ).toBeNull();
  });

  it("keeps long unsaved prompts across tabs and saves both values together", async () => {
    const executePrompt = `Execute start\n${"execute detail\n".repeat(80)}Execute end`;
    const verifyPrompt = `Verify start\n${"verify detail\n".repeat(80)}Verify end`;
    renderPage({ "workflows/update": () => workflow() }, [workflow()]);
    const dialog = await openEditDialog();

    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Execute prompt" }),
      { target: { value: executePrompt } },
    );
    fireEvent.click(within(dialog).getByRole("tab", { name: "Verify prompt" }));
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Verify prompt" }),
      { target: { value: verifyPrompt } },
    );
    fireEvent.click(
      within(dialog).getByRole("tab", { name: "Execute prompt" }),
    );
    expect(
      within(dialog).getByRole("textbox", { name: "Execute prompt" }),
    ).toHaveProperty("value", executePrompt);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(rpcCall("workflows/update")?.params).toMatchObject({
        execute_prompt: executePrompt,
        verify_prompt: verifyPrompt,
      }),
    );
  });

  it("shows workflow orchestration read-only without exposing the parent contract name", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    // name + description + the selected step prompt; the parent contract adds no editable field.
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(3);
    expect(within(dialog).getByText("Workflow orchestration")).toBeTruthy();
    expect(within(dialog).queryByText("Parent")).toBeNull();
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[0],
    );

    const parent = screen.getByRole("dialog", {
      name: "Workflow orchestration system prompt",
    });
    expect(
      await within(parent).findByText(/Parent contract body/),
    ).toBeTruthy();
    expect(within(parent).queryByRole("textbox")).toBeNull();
  });

  it("keeps the edit dialog and its input open when closing a nested dialog from its backdrop", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "unsaved workflow" } });
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[1],
    );

    const systemPromptDialog = screen.getByRole("dialog", {
      name: "Execute system prompt",
    });
    fireEvent.click(systemPromptDialog.parentElement!);

    expect(
      screen.queryByRole("dialog", { name: "Execute system prompt" }),
    ).toBeNull();
    expect(
      within(screen.getByRole("dialog", { name: 'Edit "standard"' })).getByRole(
        "textbox",
        { name: "Name" },
      ),
    ).toHaveProperty("value", "unsaved workflow");
  });

  it("focuses the workflow form, closes with Escape, and restores trigger focus", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    fireEvent.keyDown(name, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: 'Edit "standard"' }),
    ).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit" }),
    );
  });

  it("traps Tab and Shift+Tab focus within the edit dialog", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    const close = within(dialog).getByRole("button", {
      name: 'Close Edit "standard"',
    });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });

    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });

  it("switches prompt tabs with arrow keys and keeps only the active tab focusable", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    const execute = within(dialog).getByRole("tab", {
      name: "Execute prompt",
    });
    const verify = within(dialog).getByRole("tab", { name: "Verify prompt" });

    execute.focus();
    fireEvent.keyDown(execute, { key: "ArrowRight" });
    expect(verify.getAttribute("aria-selected")).toBe("true");
    expect(verify.tabIndex).toBe(0);
    expect(execute.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(verify);
    expect(
      within(dialog).getByRole("textbox", { name: "Verify prompt" }),
    ).toBeTruthy();
  });

  it("shows the fixed system prompt in the configured language", async () => {
    renderPage(
      {
        "settings/get": () => ({ workflowContractLanguage: "ja" }),
        "workflows/contracts": () => ({
          parent: "# Parent workflow contract\n日本語の parent contract 本文",
          execute: "# Execute ステップ contract\n日本語の contract 本文",
          verify: "# Verify ステップ contract\n日本語の contract 本文",
        }),
      },
      [workflow()],
    );
    const dialog = await openEditDialog();
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[1],
    );

    expect(
      await within(
        screen.getByRole("dialog", { name: "Execute system prompt" }),
      ).findByText(/日本語の contract 本文/),
    ).toBeTruthy();

    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Execute system prompt" }),
      { key: "Escape" },
    );
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[0],
    );

    expect(
      await within(
        screen.getByRole("dialog", {
          name: "Workflow orchestration system prompt",
        }),
      ).findByText(/日本語の parent contract 本文/),
    ).toBeTruthy();
  });

  it("shows system prompt links on the edit form and closes the dialog with its button", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();

    expect(
      within(dialog).getAllByRole("button", { name: "System prompt" }),
    ).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("tab", { name: "Verify prompt" }));
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[1],
    );
    const promptDialog = screen.getByRole("dialog", {
      name: "Verify system prompt",
    });
    expect(
      await within(promptDialog).findByText(/Verify contract body/),
    ).toBeTruthy();
    fireEvent.click(
      within(promptDialog).getByRole("button", { name: "Close system prompt" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Verify system prompt" }),
    ).toBeNull();
    expect(
      screen.getByRole("dialog", { name: 'Edit "standard"' }),
    ).toBeTruthy();
  });

  it("surfaces a 422 validation error as a form error on save", async () => {
    renderPage(
      {
        "workflows/update": () => {
          throw new RpcFault(422, "workflow name must be unique");
        },
      },
      [workflow()],
    );
    const dialog = await openEditDialog();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "other" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(
      await screen.findByText(/workflow name must be unique/),
    ).toBeTruthy();
  });

  it("archives a workflow and removes it from the active list", async () => {
    let workflows = [workflow()];
    renderPage(
      {
        "workflows/list": () => workflows,
        "workflows/archive": () => {
          workflows = [];
          return workflow({ archived_at: "2026-08-02T00:00:00Z" });
        },
      },
      workflows,
    );
    await screen.findByText("standard");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog", {
      name: 'Archive "standard"?',
    });
    expect(
      within(dialog).getByText(/Existing workflow runs are preserved/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    expect(await screen.findByText("No workflows yet.")).toBeTruthy();
    expect(rpcCall("workflows/archive")?.params).toMatchObject({
      id: 1,
    });
  });

  it("surfaces an RPC error when archiving a workflow", async () => {
    renderPage(
      {
        "workflows/archive": () => {
          throw new RpcFault(500, "workflow archive failed");
        },
      },
      [workflow()],
    );
    await screen.findByText("standard");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(within(dialog).getByText(/workflow archive failed/)).toBeTruthy(),
    );
    expect(
      within(dialog).getByRole("button", { name: "Archive" }),
    ).toBeTruthy();
    expect(screen.getByText("standard")).toBeTruthy();
  });
});
