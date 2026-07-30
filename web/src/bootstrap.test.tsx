import { act, screen } from "@testing-library/react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { bootstrap } from "./bootstrap";

let root: Root | undefined;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe("bootstrap", () => {
  it("shows a visible error when initial settings cannot be loaded", async () => {
    const rootElement = document.createElement("div");
    document.body.append(rootElement);

    await act(async () => {
      root = await bootstrap(rootElement, {
        getWebConfig: async () => ({
          experimental: false,
          debug: false,
        }),
        getSettings: async () => {
          throw new ApiError(500, "database unavailable");
        },
      });
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Unable to start LoopHub");
    expect(alert.textContent).toContain(
      "Failed to load settings: database unavailable",
    );
  });
});
