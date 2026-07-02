import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFixedLoading } from "./use-fixed-loading";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Harness({ durationMs }: { durationMs?: number }) {
  const [isLoading, start] = useFixedLoading(durationMs);
  return (
    <>
      <span data-testid="loading">{isLoading ? "yes" : "no"}</span>
      <button type="button" onClick={start}>
        go
      </button>
    </>
  );
}

describe("useFixedLoading", () => {
  it("flips to loading on start and back after the fixed duration", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness durationMs={1000} />);

    expect(screen.getByTestId("loading").textContent).toBe("no");
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByTestId("loading").textContent).toBe("yes");

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByTestId("loading").textContent).toBe("yes");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("loading").textContent).toBe("no");
  });

  it("restarts the timer on a second start before the first elapses", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Harness durationMs={1000} />);

    fireEvent.click(screen.getByRole("button", { name: "go" }));
    act(() => {
      vi.advanceTimersByTime(700);
    });
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    act(() => {
      vi.advanceTimersByTime(700);
    });
    // 1400ms since the first start, but only 700ms since the restart — still loading.
    expect(screen.getByTestId("loading").textContent).toBe("yes");

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId("loading").textContent).toBe("no");
  });
});
