import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, RpcFault } from "@/api/rpc-mock";
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
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkflowsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkflowsPage", () => {
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
    const executeField = (await screen.findByRole("textbox", {
      name: "Execute prompt",
    })) as HTMLTextAreaElement;
    expect(executeField.value).toBe(WORKFLOW_EXAMPLE_PROMPTS.execute_prompt);
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

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
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
      await within(screen.getByRole("dialog")).findByText(
        /日本語の contract 本文/,
      ),
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
    expect(screen.queryByRole("dialog")).toBeNull();
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
