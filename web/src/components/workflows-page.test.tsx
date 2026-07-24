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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
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
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.getByRole("dialog", { name: 'Edit "standard"' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkflowsPage", () => {
  it("shows the shared tab navigation and returns to Agent settings", async () => {
    const { router } = renderPage({});

    const tablist = await screen.findByRole("tablist", {
      name: "Settings categories",
    });
    expect(
      within(tablist)
        .getByRole("tab", { name: "Workflows" })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(within(tablist).getByRole("tab", { name: "Agent" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings"),
    );
    expect(screen.getByTestId("settings-page")).toBeTruthy();
  });

  it("shows the shared settings header above the workflow management content", async () => {
    renderPage({});

    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Instance-level settings for this LoopHub server."),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Workflows" }),
    ).toBeTruthy();
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

  it("shows both prompt fields at a comfortable multiline height", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();

    for (const name of ["Execute prompt", "Verify prompt"]) {
      expect(within(dialog).getByRole("textbox", { name }).classList).toContain(
        "min-h-48",
      );
    }
  });

  it("shows the parent contract read-only on the edit form, without a prompt field of its own", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    // name + description + the two step prompts; the parent contract adds no editable field.
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(4);
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[0],
    );

    const parent = screen.getByRole("dialog", {
      name: "Parent system prompt",
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

  it("focuses the workflow form so Escape closes the dialog immediately", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    fireEvent.keyDown(name, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: 'Edit "standard"' }),
    ).toBeNull();
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
        screen.getByRole("dialog", { name: "Parent system prompt" }),
      ).findByText(/日本語の parent contract 本文/),
    ).toBeTruthy();
  });

  it("shows system prompt links on the edit form and closes the dialog with its button", async () => {
    renderPage({}, [workflow()]);
    const dialog = await openEditDialog();

    expect(
      within(dialog).getAllByRole("button", { name: "System prompt" }),
    ).toHaveLength(3);
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "System prompt" })[2],
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

  it("surfaces the 409 refusal when deleting a workflow used by an active run", async () => {
    renderPage(
      {
        "workflows/delete": () => {
          throw new RpcFault(
            409,
            "workflow is referenced by an active workflow run",
          );
        },
      },
      [workflow()],
    );
    await screen.findByText("standard");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        within(dialog).getByText(
          /workflow is referenced by an active workflow run/,
        ),
      ).toBeTruthy(),
    );
  });
});
