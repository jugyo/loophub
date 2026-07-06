import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeToggle } from "./theme-toggle";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
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
  it("toggles the theme and persists the choice", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /light theme/i });

    fireEvent.click(button);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByRole("button", { name: /dark theme/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dark theme/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
