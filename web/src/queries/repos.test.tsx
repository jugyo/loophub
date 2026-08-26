import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "#loophub-test";
import { mockRpcFetch } from "@/api/rpc-mock";
import { queryKeys } from "./keys";
import { useRenameRepo, useSetRepoFavorite } from "./repos";

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

describe("repository mutations", () => {
  it("お気に入り更新時にホームのダッシュボードクエリも再取得する", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "repos/setFavorite": () => ({}) }));
    const { invalidateQueries, wrapper } = setupQueryClient();
    const { result } = renderHook(() => useSetRepoFavorite("me", "proj"), {
      wrapper,
    });

    act(() => result.current.mutate(true));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard(),
    });
  });

  it("リポジトリ名の更新時にホームのダッシュボードクエリも再取得する", async () => {
    vi.stubGlobal("fetch", mockRpcFetch({ "repos/rename": () => ({}) }));
    const { invalidateQueries, wrapper } = setupQueryClient();
    const { result } = renderHook(() => useRenameRepo("me", "proj"), {
      wrapper,
    });

    act(() => result.current.mutate("renamed"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard(),
    });
  });
});
