import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archivedRoute } from "./archived";
import { indexRoute } from "./index";
import { rootRoute } from "./root";
import { uiCatalogRoute } from "./ui-catalog";

vi.mock("@/lib/use-loophub-events", () => ({
  useLoopHubEvents: vi.fn(),
}));

vi.mock("@/queries/repos", () => ({
  useRepos: () => ({ data: [], isLoading: false, isError: false }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
});

function renderRoute(initialPath: string) {
  const routeTree = rootRoute.addChildren([
    indexRoute,
    archivedRoute,
    uiCatalogRoute,
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("UiCatalogPage", () => {
  it("renders outside the shared app layout at /__ui", async () => {
    renderRoute("/__ui");

    expect(
      await screen.findByRole("heading", {
        name: "Components and theme tokens",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /LoopHub/ })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Repository navigation" }),
    ).toBeNull();
  });

  it("applies theme changes only to the catalog wrapper", async () => {
    document.documentElement.classList.add("theme-dark", "dark");
    document.documentElement.dataset.theme = "dark";

    const { container } = renderRoute("/__ui");

    const catalog = await screen.findByText("LoopHub UI catalog");
    const wrapper = catalog.closest("[data-catalog-theme]");
    expect(wrapper?.getAttribute("data-catalog-theme")).toBe("light");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Catalog theme" }),
    );
    const forestItem = await screen.findByText("Forest");
    expect(forestItem.closest("[data-catalog-theme]")).toBe(wrapper);
    fireEvent.click(forestItem);

    expect(wrapper?.getAttribute("data-catalog-theme")).toBe("forest");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("theme-dark")).toBe(
      true,
    );
    expect(
      container.querySelector("[data-catalog-theme='forest']"),
    ).toBeTruthy();
  });

  describe("Coding agent settings prototypes", () => {
    it("renders all prototype variants with their intent notes", async () => {
      renderRoute("/__ui");

      expect(
        await screen.findByRole("heading", {
          name: /Coding agent 設定 UI — プロトタイプ/,
        }),
      ).toBeTruthy();
      for (const title of [
        "選択中の agent だけ展開する",
        "全 agent を 1 行テーブルで比較する",
        "select 1 つにまとめる",
        "repo override も同じテーブル言語に",
      ]) {
        expect(
          screen.getByRole("heading", { name: new RegExp(title) }),
        ).toBeTruthy();
      }
      // A short "what it improves" note accompanies each variant.
      expect(document.body.textContent).toContain("ネストの折り返しがなくなる");
    });

    it("prototype A reacts to choosing an agent", async () => {
      renderRoute("/__ui");

      const codexRadio = await screen.findByRole("radio", { name: "Codex" });
      fireEvent.click(codexRadio);
      expect(screen.getByText(/Codex — Default model & effort/)).toBeTruthy();
    });

    it("prototype B moves the default marker across rows", async () => {
      renderRoute("/__ui");

      const claudeDefault = await screen.findByRole("button", {
        name: "Claude Code — default",
      });
      const opencodeDefault = screen.getByRole("button", {
        name: "OpenCode — default",
      });
      // Claude Code starts as the default row.
      expect(claudeDefault.innerHTML).toContain("bg-primary");
      expect(opencodeDefault.innerHTML).not.toContain("bg-primary");

      fireEvent.click(opencodeDefault);
      expect(opencodeDefault.innerHTML).toContain("bg-primary");
      expect(claudeDefault.innerHTML).not.toContain("bg-primary");
    });

    it("prototype C agent picker offers no Default item and never crashes", async () => {
      renderRoute("/__ui");

      fireEvent.pointerDown(
        await screen.findByRole("button", {
          name: "Default coding agent (prototype C)",
        }),
      );
      // Selecting an empty "Default" used to pass "" → RUNTIMES[""] and crash the catalog (review #40).
      // The agent picker must not offer it; model/effort keeps "Default" meaning "runtime default".
      expect(screen.queryByRole("menuitem", { name: "Default" })).toBeNull();

      fireEvent.click(await screen.findByRole("menuitem", { name: "Codex" }));
      expect(screen.getByText(/Codex — Default model & effort/)).toBeTruthy();
    });

    it("prototype B is marked selected and drops the Default wording", async () => {
      renderRoute("/__ui");

      const sectionB = (
        await screen.findByText("案 B — 全 agent を 1 行テーブルで比較する")
      ).closest(
        "[data-debug-component='CodingAgentPrototypeB']",
      ) as HTMLElement;
      // Human feedback: "B がいいね。Default という表現はやや confusing なので不要。"
      expect(sectionB.textContent).toContain("selected");
      expect(sectionB.textContent).not.toContain("Default");
    });

    it("prototype D model picker still offers Default for model/effort", async () => {
      renderRoute("/__ui");

      fireEvent.pointerDown(
        await screen.findByRole("button", { name: "Model (prototype D)" }),
      );
      expect(screen.getByRole("menuitem", { name: "Default" })).toBeTruthy();
    });
  });
});
