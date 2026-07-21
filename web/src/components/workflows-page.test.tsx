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
import { WORKFLOW_EXAMPLE_PROMPTS } from "../../../core/workflow/example-prompts.ts";
import { WorkflowsPage } from "./workflows-page";

const STEP_CONTRACTS = {
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
      "workflows/contracts": () => STEP_CONTRACTS,
      "settings/get": () => ({ workflowContractLanguage: "en" }),
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

  it("prefills the create form with the core example prompts (no DB seed)", async () => {
    renderPage({});
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "New workflow" });
    const executeField = within(dialog).getByRole("textbox", {
      name: "Execute prompt",
    }) as HTMLTextAreaElement;
    expect(executeField.value).toBe(WORKFLOW_EXAMPLE_PROMPTS.execute_prompt);
  });

  it("creates a workflow in a dialog and refreshes the list", async () => {
    let workflows: Workflow[] = [];
    renderPage({
      "workflows/list": () => workflows,
      "workflows/create": (params) => {
        const created = workflow({
          id: 2,
          name: params.name,
          description: params.description,
          execute_prompt: params.execute_prompt,
          verify_prompt: params.verify_prompt,
        });
        workflows = [created];
        return created;
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );
    const dialog = screen.getByRole("dialog", { name: "New workflow" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "fast-loop" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create workflow" }),
    );

    expect(await screen.findByText("fast-loop")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New workflow" })).toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: 'Edit "standard"' });
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

  it("shows every system prompt in a read-only dialog on the create form", async () => {
    renderPage({});
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );

    const links = screen.getAllByRole("button", { name: "System prompt" });
    expect(links).toHaveLength(2);
    fireEvent.click(links[0]);

    const dialog = screen.getByRole("dialog", {
      name: "Execute system prompt",
    });
    expect(
      await within(dialog).findByText(/Execute contract body/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("textbox")).toBeNull();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Execute system prompt" }),
    ).toBeNull();
    expect(screen.getByRole("dialog", { name: "New workflow" })).toBeTruthy();
  });

  it("keeps the workflow dialog and its input open when closing a nested dialog from its backdrop", async () => {
    renderPage({});
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );
    const workflowDialog = screen.getByRole("dialog", {
      name: "New workflow",
    });
    const name = within(workflowDialog).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "unsaved workflow" } });
    fireEvent.click(
      within(workflowDialog).getAllByRole("button", {
        name: "System prompt",
      })[0],
    );

    const systemPromptDialog = screen.getByRole("dialog", {
      name: "Execute system prompt",
    });
    fireEvent.click(systemPromptDialog.parentElement!);

    expect(
      screen.queryByRole("dialog", { name: "Execute system prompt" }),
    ).toBeNull();
    expect(
      within(screen.getByRole("dialog", { name: "New workflow" })).getByRole(
        "textbox",
        { name: "Name" },
      ),
    ).toHaveProperty("value", "unsaved workflow");
  });

  it("focuses the workflow form so Escape closes the dialog immediately", async () => {
    renderPage({});
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );

    const dialog = screen.getByRole("dialog", { name: "New workflow" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(document.activeElement).toBe(name);
    fireEvent.keyDown(name, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "New workflow" })).toBeNull();
  });

  it("shows the fixed system prompt in the configured language", async () => {
    renderPage({
      "settings/get": () => ({ workflowContractLanguage: "ja" }),
      "workflows/contracts": () => ({
        execute: "# Execute ステップ contract\n日本語の contract 本文",
        verify: "# Verify ステップ contract\n日本語の contract 本文",
      }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "System prompt" })[0],
    );

    expect(
      await within(
        screen.getByRole("dialog", { name: "Execute system prompt" }),
      ).findByText(/日本語の contract 本文/),
    ).toBeTruthy();
  });

  it("shows system prompt links on the edit form and closes the dialog with its button", async () => {
    renderPage({}, [workflow()]);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(
      screen.getAllByRole("button", { name: "System prompt" }),
    ).toHaveLength(2);
    fireEvent.click(
      screen.getAllByRole("button", { name: "System prompt" })[1],
    );
    const dialog = screen.getByRole("dialog", {
      name: "Verify system prompt",
    });
    expect(
      await within(dialog).findByText(/Verify contract body/),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close system prompt" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Verify system prompt" }),
    ).toBeNull();
    expect(
      screen.getByRole("dialog", { name: 'Edit "standard"' }),
    ).toBeTruthy();
  });

  it("surfaces a 422 validation error as a form error on create", async () => {
    renderPage({
      "workflows/create": () => {
        throw new RpcFault(422, "workflow name must be unique");
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "New workflow" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "standard" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }));
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
