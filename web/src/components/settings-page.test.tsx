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
import { mockRpcFetch, rpcCall } from "@/api/rpc-mock";
import type { TerminalLaunchBackend } from "@/api/types";
import { SettingsPage } from "./settings-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(
  initialBackend: TerminalLaunchBackend,
  initialAutoModeOnBuild = false,
) {
  let backend = initialBackend;
  let autoModeOnBuild = initialAutoModeOnBuild;
  return mockRpcFetch({
    "settings/get": () => ({
      terminalLaunchBackend: backend,
      autoModeOnBuild,
    }),
    "settings/update": (p) => {
      if (p.terminalLaunchBackend) backend = p.terminalLaunchBackend;
      if (p.autoModeOnBuild !== undefined) autoModeOnBuild = p.autoModeOnBuild;
      return { terminalLaunchBackend: backend, autoModeOnBuild };
    },
  });
}

function renderSettings(
  initialBackend: TerminalLaunchBackend = "builtin",
  initialAutoModeOnBuild = false,
) {
  vi.stubGlobal("fetch", mockFetch(initialBackend, initialAutoModeOnBuild));
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

  it("shows the current auto-mode-on-Build setting as checked", async () => {
    renderSettings("builtin", true);
    // The label ("On"/"Off") and hint text are adjacent in the accessible name, so scope the
    // query to the radiogroup and pick by position instead of matching the name by text.
    const group = await screen.findByRole("radiogroup", {
      name: /auto mode on build/i,
    });
    const [offOption, onOption] = within(group).getAllByRole("radio");
    await waitFor(() =>
      expect(onOption.getAttribute("aria-checked")).toBe("true"),
    );
    expect(offOption.getAttribute("aria-checked")).toBe("false");
  });

  it("switches auto-mode-on-Build and persists via settings/update", async () => {
    renderSettings("builtin", false);
    const group = await screen.findByRole("radiogroup", {
      name: /auto mode on build/i,
    });
    const [, onOption] = within(group).getAllByRole(
      "radio",
    ) as HTMLButtonElement[];
    await waitFor(() => expect(onOption.disabled).toBe(false));
    fireEvent.click(onOption);

    await waitFor(() => {
      const call = rpcCall("settings/update");
      expect(call).toBeTruthy();
      expect(call!.params).toMatchObject({ autoModeOnBuild: true });
    });
    await waitFor(() =>
      expect(onOption.getAttribute("aria-checked")).toBe("true"),
    );
  });
});
