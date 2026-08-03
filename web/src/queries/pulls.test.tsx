import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import { queryKeys } from "./keys";
import { useMergePull, usePostPullComment, usePushGithubPull } from "./pulls";

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
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.pullDebug("me/proj", 13),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.pullFiles("me/proj", 13),
    });
  });
});

describe("usePushGithubPull", () => {
  it("invalidates debug and GitHub status after a push", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pulls/pushGithubPull": () => ({
          number: 7,
          url: "https://github.com/me/proj/pull/7",
          branch: "feature",
          created_by: "me",
          created_at: "2026-08-03T00:00:00Z",
          github_merged: false,
          github_merged_at: null,
          pushed_sha: "pushed-sha",
        }),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePushGithubPull("me", "proj", 13), {
      wrapper,
    });

    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.pullDebug("me/proj", 13),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.githubPrStatus("me/proj", 13),
    });
  });
});

describe("usePostPullComment", () => {
  it("invalidates the conversation, pull detail, and debug dump", async () => {
    vi.stubGlobal(
      "fetch",
      mockRpcFetch({
        "pullComments/create": () => ({
          id: 5,
          user: { login: "me" },
          author_type: "human",
          body: "Looks good",
          created_at: "2026-08-03T00:00:00Z",
          reactions: [],
        }),
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePostPullComment("me", "proj", 13), {
      wrapper,
    });

    act(() => result.current.mutate("Looks good"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.issueComments("me/proj", 13),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.pull("me/proj", 13),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.pullDebug("me/proj", 13),
    });
  });
});
