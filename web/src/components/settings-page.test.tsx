import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { TerminalLaunchBackend } from "@/api/types";
import { SettingsPage } from "./settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(initialBackend: TerminalLaunchBackend) {
  let backend = initialBackend;
  return mockRpcFetch({
    "settings/get": () => ({ terminalLaunchBackend: backend }),
    "settings/update": (p) => {
      if (p.terminalLaunchBackend) backend = p.terminalLaunchBackend;
      return { terminalLaunchBackend: backend };
    },
  });
}

function renderSettings(initialBackend: TerminalLaunchBackend = "builtin") {
  vi.stubGlobal("fetch", mockFetch(initialBackend));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  it("shows the current terminal launch backend as checked", async () => {
    renderSettings("herdr");
    const herdrOption = await screen.findByRole("radio", { name: /herdr/i });
    await waitFor(() =>
      expect(herdrOption.getAttribute("aria-checked")).toBe("true"),
    );
    const builtinOption = screen.getByRole("radio", { name: /builtin/i });
    expect(builtinOption.getAttribute("aria-checked")).toBe("false");
  });

  it("switches the backend and persists via settings/update", async () => {
    renderSettings("builtin");
    const herdrOption = (await screen.findByRole("radio", {
      name: /herdr/i,
    })) as HTMLButtonElement;
    await waitFor(() => expect(herdrOption.disabled).toBe(false));
    fireEvent.click(herdrOption);

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ terminalLaunchBackend: "herdr" });
    });
    await waitFor(() =>
      expect(herdrOption.getAttribute("aria-checked")).toBe("true"),
    );
  });
});
