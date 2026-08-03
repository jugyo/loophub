import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import { queryKeys } from "./keys";
import { useCreateWorkspace, useSetWorkspaceArchived } from "./workspaces";

afterEach(() => {
  vi.restoreAllMocks();
});

function setupQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidateQueries, wrapper };
}

function expectWorkspaceConsumersInvalidated(
  invalidateQueries: ReturnType<typeof vi.spyOn>,
) {
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.workspaces("me/proj"),
  });
  expect(invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.issues("me/proj"),
  });
}

describe("workspace mutations", () => {
  it("refreshes issue-list page data after creating a workspace", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({ "workspaces/create": () => ({ branch: "integration" }) }),
    );
    const { invalidateQueries, wrapper } = setupQueryClient();
    const { result } = renderHook(() => useCreateWorkspace("me", "proj"), {
      wrapper,
    });

    act(() => result.current.mutate("integration"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expectWorkspaceConsumersInvalidated(invalidateQueries);
  });

  it.each([
    [true, "workspaces/archive"],
    [false, "workspaces/unarchive"],
  ] as const)("refreshes issue-list page data when archived is %s", async (archived, method) => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({ [method]: () => ({ branch: "integration" }) }),
    );
    const { invalidateQueries, wrapper } = setupQueryClient();
    const { result } = renderHook(() => useSetWorkspaceArchived("me", "proj"), {
      wrapper,
    });

    act(() => result.current.mutate({ branch: "integration", archived }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expectWorkspaceConsumersInvalidated(invalidateQueries);
  });
});
