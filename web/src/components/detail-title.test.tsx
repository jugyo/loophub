import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailStickyHeader } from "./detail-title";

// happy-dom ships a no-op IntersectionObserver, so the visibility toggle is driven by
// capturing the observer callback and firing it with the intersection we want to test.
function stubIntersectionObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
      takeRecords() {
        return [];
      }
    },
  );
  return {
    disconnect,
    setIntersecting(isIntersecting: boolean) {
      act(() => {
        for (const callback of callbacks) {
          callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        }
      });
    },
  };
}

const LONG_TITLE =
  "A very long pull request title that does not fit the header";

function renderStickyHeader() {
  const titleRef = createRef<HTMLDivElement>();
  const { container, unmount } = render(
    <>
      <div ref={titleRef}>page title</div>
      <DetailStickyHeader
        kind="PR"
        number={2034}
        title={LONG_TITLE}
        badges={[{ tone: "conflict", label: "conflict" }]}
        titleRef={titleRef}
      />
    </>,
  );
  return {
    unmount,
    bar: () =>
      container.querySelector('[data-debug-component="DetailStickyHeader"]'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DetailStickyHeader", () => {
  it("stays hidden while the page-top title is in view", () => {
    const observer = stubIntersectionObserver();
    const { bar } = renderStickyHeader();

    observer.setIntersecting(true);
    expect(bar()).toBeNull();
  });

  it("shows number, title and status on one line once the title scrolls out of view", () => {
    const observer = stubIntersectionObserver();
    const { bar } = renderStickyHeader();

    observer.setIntersecting(false);
    expect(bar()?.textContent).toBe(`PR #2034${LONG_TITLE}conflict`);
  });

  it("truncates the title instead of wrapping the header", () => {
    const observer = stubIntersectionObserver();
    const { bar } = renderStickyHeader();

    observer.setIntersecting(false);
    expect(bar()?.querySelector("span.truncate")?.textContent).toBe(LONG_TITLE);
  });

  it("takes pointer events on the opaque bar, not on the zero-height wrapper", () => {
    const observer = stubIntersectionObserver();
    const { bar } = renderStickyHeader();

    observer.setIntersecting(false);
    expect(bar()?.className).toContain("pointer-events-auto");
    expect(bar()?.parentElement?.className).toContain("pointer-events-none");
  });

  it("hides itself again when the title scrolls back into view", () => {
    const observer = stubIntersectionObserver();
    const { bar } = renderStickyHeader();

    observer.setIntersecting(false);
    expect(bar()).not.toBeNull();
    observer.setIntersecting(true);
    expect(bar()).toBeNull();
  });

  it("disconnects the observer on unmount", () => {
    const observer = stubIntersectionObserver();
    const { unmount } = renderStickyHeader();

    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });
});
