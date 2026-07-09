import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_APPEARANCE_STORAGE_KEY, THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeToggle } from "./theme-toggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: !query.includes("light"), // OS prefers dark
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("selects themes and persists the choice", async () => {
    render(<ThemeToggle />);
    const trigger = screen.getByRole("button", { name: "Theme" });

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /solarized light/i }),
    );
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("solarized");
    expect(localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-solarized")).toBe(
      true,
    );
    expect(document.documentElement.dataset.theme).toBe("solarized");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /midnight/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("midnight");
    expect(localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-midnight")).toBe(
      true,
    );
  });
});
