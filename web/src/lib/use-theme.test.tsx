import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getThemeDefinition, THEME_STORAGE_KEY } from "./theme";
import { useTheme } from "./use-theme";

function Harness() {
  const { theme } = useTheme();
  return <span data-testid="theme">{theme}</span>;
}

function emitStorage(newValue: string | null) {
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  cleanup();
});

describe("useTheme", () => {
  it("adopts a theme switched in another tab", () => {
    render(<Harness />);
    expect(screen.getByTestId("theme").textContent).toBe("light");

    emitStorage("midnight");

    const root = document.documentElement;
    expect(screen.getByTestId("theme").textContent).toBe("midnight");
    expect(root.classList.contains("theme-midnight")).toBe(true);
    expect(root.classList.contains("theme-light")).toBe(false);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.dataset.theme).toBe("midnight");
    expect(root.style.getPropertyValue("--background")).toBe(
      getThemeDefinition("midnight").tokens.background,
    );
  });

  it("ignores invalid values from another tab", () => {
    render(<Harness />);

    emitStorage("neon");

    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("stops adopting other tabs' changes after unmount", () => {
    const { unmount } = render(<Harness />);
    unmount();

    emitStorage("forest");

    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});
