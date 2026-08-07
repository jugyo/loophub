import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullSectionTabs, spyRootMargin } from "./pull-section-tabs";

// happy-dom ships a no-op IntersectionObserver, so both the scrollspy and the sticky-header
// handoff are driven by capturing the observer callbacks and firing the intersections we want.
// Entries are dispatched by element id to the observer that actually observes that element, so the
// two observers this component creates can be moved independently.
function stubIntersectionObserver() {
  const observers: FakeObserver[] = [];
  const disconnect = vi.fn();
  class FakeObserver {
    targets = new Set<Element>();
    callback: IntersectionObserverCallback;
    options: IntersectionObserverInit | undefined;
    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      this.callback = callback;
      this.options = options;
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect = disconnect;
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  return {
    disconnect,
    /** The observer watching the sections, i.e. the scrollspy rather than the sticky handoff. */
    sectionObserver: () =>
      observers.find((observer) =>
        [...observer.targets].some((target) => target.id === "overview"),
      ),
    /** Fires `{ [element id]: isIntersecting }` at whichever observer watches those elements. */
    intersect(states: Record<string, boolean>) {
      act(() => {
        for (const observer of observers) {
          const entries = [...observer.targets]
            .filter((target) => target.id in states)
            .map(
              (target) =>
                ({
                  target,
                  isIntersecting: states[target.id],
                }) as IntersectionObserverEntry,
            );
          if (entries.length > 0)
            observer.callback(
              entries,
              observer as unknown as IntersectionObserver,
            );
        }
      });
    },
  };
}

// The sections the tabs anchor to are rendered as the page does: inside the app's scrollport,
// after the bar, with the ids it links to, plus the page title the sticky-header handoff watches.
function renderTabs() {
  const titleRef = createRef<HTMLDivElement>();
  const { container, unmount } = render(
    // The app shell's scrollport carries pt-6; the band's inset has to account for it because an
    // element root's rect starts inside that padding (app-layout.tsx).
    <main style={{ paddingTop: "24px" }}>
      <div id="overview">
        <div id="page-title" ref={titleRef}>
          PR #60
        </div>
      </div>
      <PullSectionTabs titleRef={titleRef} />
      <div id="pull-body">description</div>
      <div id="commits">commits</div>
      <div id="files-changed">files changed</div>
      <div id="comments">comments</div>
    </main>,
  );
  const scroller = container.querySelector("main");
  return {
    container,
    unmount,
    bar: () =>
      container.querySelector('[data-debug-component="PullSectionTabs"]'),
    activeTab: () =>
      container.querySelector('a[aria-current="location"]')?.textContent,
    // happy-dom lays nothing out, so the scroll position the bar reads is stated outright.
    scrollTo(scrollTop: number) {
      if (!scroller) throw new Error("scrollport not found");
      for (const [key, value] of Object.entries({
        scrollTop,
        clientHeight: 900,
        scrollHeight: 3000,
      })) {
        Object.defineProperty(scroller, key, { value, configurable: true });
      }
      fireEvent.scroll(scroller);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PullSectionTabs", () => {
  it("links each section as a same-page anchor", () => {
    stubIntersectionObserver();
    renderTabs();

    expect(
      screen
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Overview", "#overview"],
      ["Commits", "#commits"],
      ["Files changed", "#files-changed"],
      ["Comments", "#comments"],
    ]);
  });

  it("smoothly scrolls to the selected section without changing the anchor", () => {
    stubIntersectionObserver();
    const { container } = renderTabs();
    const target = container.querySelector("#commits");
    if (!target) throw new Error("commits section not found");
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    fireEvent.click(screen.getByRole("link", { name: "Commits" }));

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it.each([
    ["Alt", { altKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["Meta", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["middle", { button: 1 }],
  ])("keeps native anchor behavior for %s-clicks", (_name, options) => {
    stubIntersectionObserver();
    const { container } = renderTabs();
    const target = container.querySelector("#commits");
    if (!target) throw new Error("commits section not found");
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    const link = screen.getByRole("link", { name: "Commits" });
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...options,
    });

    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("starts on Overview before anything has scrolled", () => {
    stubIntersectionObserver();
    const { activeTab } = renderTabs();

    expect(activeTab()).toBe("Overview");
  });

  it("follows the section that scrolls into the top band", () => {
    const observer = stubIntersectionObserver();
    const { activeTab } = renderTabs();

    observer.intersect({ overview: false, commits: true });
    expect(activeTab()).toBe("Commits");

    observer.intersect({ commits: false, "files-changed": true });
    expect(activeTab()).toBe("Files changed");

    observer.intersect({ "files-changed": false, comments: true });
    expect(activeTab()).toBe("Comments");
  });

  it("selects the topmost section when several share the band", () => {
    const observer = stubIntersectionObserver();
    const { activeTab } = renderTabs();

    observer.intersect({ "files-changed": true, comments: true });
    expect(activeTab()).toBe("Files changed");

    observer.intersect({ "files-changed": false });
    expect(activeTab()).toBe("Comments");
  });

  it("scrolls back to an earlier section's tab", () => {
    const observer = stubIntersectionObserver();
    const { activeTab } = renderTabs();

    observer.intersect({ overview: false, comments: true });
    expect(activeTab()).toBe("Comments");

    observer.intersect({ comments: false, overview: true });
    expect(activeTab()).toBe("Overview");
  });

  // Overview spans the header above the bar and the description below it, so reading the
  // description keeps its tab selected instead of leaving the tab you scrolled up from.
  it("selects Overview for the description below the bar as well as the header above it", () => {
    const observer = stubIntersectionObserver();
    const { activeTab } = renderTabs();

    observer.intersect({ overview: false, commits: true });
    expect(activeTab()).toBe("Commits");

    observer.intersect({ commits: false, "pull-body": true });
    expect(activeTab()).toBe("Overview");
  });

  it("keeps the last section selected when the band holds none", () => {
    const observer = stubIntersectionObserver();
    const { activeTab } = renderTabs();

    observer.intersect({ commits: true });
    observer.intersect({ commits: false });
    expect(activeTab()).toBe("Commits");
  });

  // The page-top section is the one the band cannot be scrolled up to; without the top-of-scroll
  // rule it would stay unselectable once left, even by following its own tab.
  it("selects the first section at the top of the scroll", () => {
    const observer = stubIntersectionObserver();
    const { activeTab, scrollTo } = renderTabs();

    observer.intersect({ comments: true });
    expect(activeTab()).toBe("Comments");

    scrollTo(0);
    expect(activeTab()).toBe("Overview");
  });

  it("hands the selection back to the band after scrolling away from the top", () => {
    const observer = stubIntersectionObserver();
    const { activeTab, scrollTo } = renderTabs();

    observer.intersect({ commits: true });
    scrollTo(0);
    scrollTo(1200);
    expect(activeTab()).toBe("Commits");
  });

  it("selects the last section at the end of the scroll, where the band can no longer reach it", () => {
    const observer = stubIntersectionObserver();
    const { activeTab, scrollTo } = renderTabs();

    observer.intersect({ commits: true });
    scrollTo(2100);
    expect(activeTab()).toBe("Comments");
  });

  it("hands the selection back to the band after scrolling away from the end", () => {
    const observer = stubIntersectionObserver();
    const { activeTab, scrollTo } = renderTabs();

    observer.intersect({ commits: true });
    scrollTo(2100);
    scrollTo(1200);
    expect(activeTab()).toBe("Commits");
  });

  it("drops below the sticky header once the page title scrolls out of view", () => {
    const observer = stubIntersectionObserver();
    const { bar } = renderTabs();

    expect(bar()?.className).toContain("-top-6");

    observer.intersect({ "page-title": false });
    expect(bar()?.className).toContain("top-5");
    expect(bar()?.className).not.toContain("-top-6");

    observer.intersect({ "page-title": true });
    expect(bar()?.className).toContain("-top-6");
  });

  it("watches the sections inside the scrollport, with the band inset past its padding", () => {
    const observer = stubIntersectionObserver();
    const { unmount } = renderTabs();

    const options = observer.sectionObserver()?.options;
    expect((options?.root as HTMLElement | null)?.tagName).toBe("MAIN");
    expect(options?.rootMargin).toBe(spyRootMargin(24));
    unmount();
  });

  it("disconnects its observers on unmount", () => {
    const observer = stubIntersectionObserver();
    const { unmount } = renderTabs();

    unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(2);
  });
});

// The band's top edge is where the bug the observer options cannot show in a layout-less DOM
// lives: an element root's rect already starts inside the scrollport's padding, so the inset has
// to be the bars' height minus that padding, not the bars' height.
describe("spyRootMargin", () => {
  it("insets by the bars' height minus the scrollport's own padding", () => {
    expect(spyRootMargin(24)).toBe("-64px 0px -60% 0px");
  });

  it("insets by the full bar height when the scrollport has no padding", () => {
    expect(spyRootMargin(0)).toBe("-88px 0px -60% 0px");
  });

  it("never insets upward when the padding already clears the bars", () => {
    expect(spyRootMargin(120)).toBe("0px 0px -60% 0px");
  });
});
