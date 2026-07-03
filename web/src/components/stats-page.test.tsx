import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch } from "@/api/rpc-mock";
import type { Stats } from "@/api/types";
import { formatBytes, StatsPage } from "./stats-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STATS: Stats = {
  database: {
    path: "/home/u/.loophub/loophub.db",
    size_bytes: 1024 * 1024, // 1.0 MB
    wal_size_bytes: 2048, // 2.0 KB
    total_size_bytes: 1024 * 1024 + 2048,
  },
  tables: [
    { name: "issues", rows: 42 },
    { name: "repos", rows: 2 },
  ],
  repos: [
    {
      full_name: "me/proj",
      issues: { open: 3, closed: 7 },
      pulls: { open: 1, merged: 5, closed: 2 },
    },
  ],
};

function renderStats(stats: Stats = STATS) {
  vi.stubGlobal("fetch", mockRpcFetch({ "stats/get": () => stats }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StatsPage />
    </QueryClientProvider>,
  );
}

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
    // Rounding never lands on the previous unit's ceiling or "100.0":
    // 1048100 B = 1023.53 KB rounds up -> promote to MB, not "1024 KB".
    expect(formatBytes(1048100)).toBe("1.0 MB");
    // 102349 B = 99.95 KB is at toFixed(1)'s carry threshold -> "100 KB", not "100.0 KB".
    expect(formatBytes(102349)).toBe("100 KB");
    expect(formatBytes(102348)).toBe("99.9 KB");
  });
});

describe("StatsPage", () => {
  it("shows the DB file size, WAL included, in human-readable units", async () => {
    renderStats();
    // "1.0 MB" appears twice: the DB file row and the Total row (1 MB + 2 KB
    // rounds back to 1.0 MB).
    expect(await screen.findAllByText("1.0 MB")).toHaveLength(2);
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("/home/u/.loophub/loophub.db")).toBeTruthy();
  });

  it("shows 'none' when no WAL file exists", async () => {
    renderStats({
      ...STATS,
      database: {
        ...STATS.database,
        wal_size_bytes: null,
        total_size_bytes: STATS.database.size_bytes,
      },
    });
    await screen.findAllByText("1.0 MB");
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("lists every table with its row count", async () => {
    renderStats();
    expect(await screen.findByText("issues")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("repos")).toBeTruthy();
  });

  it("lists per-repo issue and PR counts", async () => {
    renderStats();
    const row = (await screen.findByText("me/proj")).closest("tr")!;
    const cells = [...row.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).toEqual(["me/proj", "3", "7", "1", "5", "2"]);
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <StatsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/failed to load stats/i)).toBeTruthy();
  });
});
