import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComponentDebugOverlay,
  ComponentDebugToggle,
  setComponentDebugMode,
} from "./component-debug-overlay";

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 210,
    bottom: 120,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  });
  act(() => setComponentDebugMode(false));
});

afterEach(() => {
  cleanup();
  act(() => setComponentDebugMode(false));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderDebugUi(name = "HomePage") {
  return render(
    <>
      <ComponentDebugToggle />
      <main data-debug-component={name}>Page</main>
      <ComponentDebugOverlay />
    </>,
  );
}

describe("component debug mode", () => {
  it("toggles all component overlays without reloading the page", async () => {
    const page = renderDebugUi();
    const toggle = screen.getByRole("button", {
      name: "Component debug mode",
    });

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("component-debug-overlay")).toBeNull();

    fireEvent.click(toggle);

    await screen.findByText("HomePage");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("component-debug-overlay")).toBeTruthy();

    page.rerender(
      <>
        <ComponentDebugToggle />
        <main data-debug-component="IssueDetail">Issue</main>
        <ComponentDebugOverlay />
      </>,
    );

    await screen.findByText("IssueDetail");
    expect(screen.queryByText("HomePage")).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByTestId("component-debug-overlay")).toBeNull(),
    );
  });

  it("copies the displayed component name", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderDebugUi("PullDetail");

    fireEvent.click(
      screen.getByRole("button", { name: "Component debug mode" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy component name: PullDetail",
      }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("PullDetail"));
  });

  it("renders every instance when repeated components share a name", async () => {
    render(
      <>
        <ComponentDebugToggle />
        <div data-debug-component="IssueRow">First issue</div>
        <div data-debug-component="IssueRow">Second issue</div>
        <ComponentDebugOverlay />
      </>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Component debug mode" }),
    );

    expect(await screen.findAllByText("IssueRow")).toHaveLength(2);
    expect(
      screen.getAllByRole("button", {
        name: "Copy component name: IssueRow",
      }),
    ).toHaveLength(2);
  });

  it("shows the full component name in a tooltip on label hover", async () => {
    renderDebugUi("VeryLongPurposeSpecificComponentName");

    fireEvent.click(
      screen.getByRole("button", { name: "Component debug mode" }),
    );
    const label = await screen.findByText(
      "VeryLongPurposeSpecificComponentName",
    );
    expect(label.parentElement?.className).toContain("text-[10px]");
    expect(label.className).toContain("px-[3px]");
    expect(label.className).toContain("py-[1px]");
    expect(screen.queryByTestId("component-debug-name-tooltip")).toBeNull();

    fireEvent.mouseEnter(label);
    const tooltip = screen.getByTestId("component-debug-name-tooltip");
    expect(tooltip.textContent).toBe("VeryLongPurposeSpecificComponentName");
    expect(tooltip.className).toContain("text-[10px]");
    expect(tooltip.className).toContain("px-[3px]");
    expect(tooltip.className).toContain("py-[1px]");

    fireEvent.mouseLeave(label);
    expect(screen.queryByTestId("component-debug-name-tooltip")).toBeNull();
  });

  it("marks the toggle with a purpose-specific debug name", () => {
    renderDebugUi();
    const toggle = screen.getByRole("button", {
      name: "Component debug mode",
    });
    expect(toggle.getAttribute("data-debug-component")).toBe(
      "ComponentDebugToggle",
    );
  });
});
