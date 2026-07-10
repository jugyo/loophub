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
import type { PevrWorkflow } from "@/api/types";
import { PEVR_EXAMPLE_PROMPTS } from "../../../core/pevr/example-prompts.ts";
import { WorkflowsPage } from "./workflows-page";

function workflow(overrides: Partial<PevrWorkflow> = {}): PevrWorkflow {
  return {
    id: 1,
    name: "standard",
    description: "The default loop",
    plan_prompt: "plan here",
    execute_prompt: "execute here",
    verify_prompt: "verify here",
    reflect_prompt: "reflect here",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderPage(
  handlers: Parameters<typeof mockRpcFetch>[0],
  workflows: PevrWorkflow[] = [],
) {
  vi.stubGlobal(
    "fetch",
    mockRpcFetch({ "pevrWorkflows/list": () => workflows, ...handlers }),
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
    const planField = (await screen.findByRole("textbox", {
      name: "Plan prompt",
    })) as HTMLTextAreaElement;
    expect(planField.value).toBe(PEVR_EXAMPLE_PROMPTS.plan_prompt);
  });

  it("surfaces a 422 validation error as a form error on create", async () => {
    renderPage({
      "pevrWorkflows/create": () => {
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
        "pevrWorkflows/delete": () => {
          throw new RpcFault(
            409,
            "workflow is referenced by an active PEVR run",
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
          /workflow is referenced by an active PEVR run/,
        ),
      ).toBeTruthy(),
    );
  });
});
