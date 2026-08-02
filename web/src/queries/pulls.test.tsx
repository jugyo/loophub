import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import { queryKeys } from "./keys";
import { useMergePull } from "./pulls";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMergePull", () => {
  it("invalidates git-derived workspace queries after a merge", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/merge": () => ({ merged: true, sha: "merged-sha" }),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMergePull("me", "proj", 13), {
      wrapper,
    });

    act(() => result.current.mutate("squash"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.workspaces("me/proj"),
    });
  });
});
