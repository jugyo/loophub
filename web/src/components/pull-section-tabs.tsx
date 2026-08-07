// Section tabs for the PR detail page (#59). The tabs are same-page anchor links, not a view
// switch: every section stays rendered on one page and a tab only moves the scroll position, so
// the page keeps reading top to bottom for anyone who prefers scrolling. The selected tab follows
// the section currently in view (scrollspy), which is what makes the bar useful while scrolled.

import { type RefObject, useEffect, useRef, useState } from "react";
import { useScrolledPast } from "@/components/detail-title";
import { cn } from "@/lib/utils";

/**
 * The anchored sections of the PR page, in page order. `id` is the element id the section renders
 * and the tab links to; the labels stay English structural labels. `watch` lists the elements that
 * count as being in the section for the scrollspy — Overview needs two of them because the bar
 * itself sits between the PR's header and its description (pull-detail.tsx).
 */
export const PULL_SECTIONS = [
  { id: "overview", label: "Overview", watch: ["overview", "pull-body"] },
  { id: "commits", label: "Commits", watch: ["commits"] },
  { id: "files-changed", label: "Files changed", watch: ["files-changed"] },
  { id: "comments", label: "Comments", watch: ["comments"] },
] as const;

/**
 * Height of the two bars a scrolled section passes under: the detail sticky header (h-11,
 * detail-title.tsx) and this bar (h-11). Sections carry the matching `scroll-mt-11` on top of the
 * scrollport's `scroll-pt-11` (app-layout.tsx) so an anchor jump lands below both.
 */
const STICKY_INSET_PX = 88;

/**
 * Only the top band of the scrollport — below the bars, down to 40% of its height — decides which
 * section is being read, so a section counts as current from the moment it reaches the top of the
 * content rather than when it happens to be the largest thing on screen.
 */
const SPY_BAND_BOTTOM = "-60%";

/**
 * The observer's rootMargin for that band, given the scrollport's own top padding.
 *
 * With an element root, the intersection rectangle is the root's **content** box: the scroll area's
 * `pt-6` is already excluded from it, while the bars the inset stands for overlay the padding too.
 * Subtracting that padding is what keeps the band's top edge on the bars' bottom edge instead of
 * `pt-6` further down — 24px that the page-top section, which cannot be scrolled up any further to
 * make up the difference, does not have to give.
 */
export function spyRootMargin(rootPaddingTop: number): string {
  const inset = Math.max(STICKY_INSET_PX - rootPaddingTop, 0);
  return `${inset === 0 ? "" : "-"}${inset}px 0px ${SPY_BAND_BOTTOM} 0px`;
}

/** The scrollport's own top padding, which its root rect already excludes. */
function scrollportPaddingTop(scroller: Element | null): number {
  if (!scroller) return 0;
  return Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
}

export function PullSectionTabs({
  titleRef,
}: {
  /** The page-top title, shared with the sticky header so the bars agree on when to stack. */
  titleRef: RefObject<HTMLDivElement | null>;
}) {
  const navRef = useRef<HTMLElement>(null);
  const active = useActiveSection(navRef);
  // The title sits above this bar, so the sticky header appears just as this bar reaches the top of
  // the scrollport. Dropping the bar by the header's height at that moment hands the top slot over:
  // the two stack instead of the header covering the tabs. -top-6 cancels the scroll area's pt-6,
  // top-5 is that same offset plus the header's h-11 (see the sidebar's lg:top-5 in
  // pull-detail.tsx).
  const belowStickyHeader = useScrolledPast(titleRef);
  return (
    <nav
      ref={navRef}
      aria-label="PR sections"
      data-debug-component="PullSectionTabs"
      className={cn(
        "sticky z-10 flex h-11 items-end gap-1 border-b bg-background/95 backdrop-blur",
        belowStickyHeader ? "top-5" : "-top-6",
      )}
    >
      {PULL_SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            ) {
              return;
            }
            event.preventDefault();
            document.getElementById(section.id)?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            });
          }}
          // "location" rather than "page": the tabs mark a place within this page, not a route.
          aria-current={active === section.id ? "location" : undefined}
          className={cn(
            "-mb-px inline-flex h-11 items-center justify-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            active === section.id
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
          )}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

/**
 * The id of the section currently in the scrollport's top band. The topmost such section wins, so
 * a short section that has just reached the top takes over from the long one it follows. When the
 * band holds no section at all the previous answer stands rather than the bar clearing itself.
 *
 * Both ends of the scroll are places the band cannot answer on its own: a section there is on
 * screen but can no longer be scrolled into the band, which would leave its tab unselectable —
 * including right after that tab was followed. So the ends answer for themselves: the top of the
 * scroll is the first section and the bottom is the last one, whatever the band says. That is also
 * what keeps the first section from depending on being tall enough to reach into the band.
 */
function useActiveSection(navRef: RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState<string>(PULL_SECTIONS[0].id);
  useEffect(() => {
    // The page scrolls inside <main>, so every signal comes from that scrollport; the pixel inset
    // is meaningless against the viewport, which starts above the app's own top bars.
    const scroller = navRef.current?.closest("main") ?? null;
    const inBand = new Set<string>();
    let atStart = false;
    let atEnd = false;
    const resolve = () => {
      // A page too short to scroll satisfies both ends at once; its reader can see all of it, so
      // the first section is the honest answer.
      if (atStart) setActive(PULL_SECTIONS[0].id);
      else if (atEnd) setActive(PULL_SECTIONS[PULL_SECTIONS.length - 1].id);
      else {
        const next = PULL_SECTIONS.find((section) =>
          section.watch.some((id) => inBand.has(id)),
        );
        if (next) setActive(next.id);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) inBand.add(entry.target.id);
          else inBand.delete(entry.target.id);
        }
        resolve();
      },
      {
        root: scroller,
        rootMargin: spyRootMargin(scrollportPaddingTop(scroller)),
      },
    );
    for (const section of PULL_SECTIONS) {
      for (const id of section.watch) {
        const element = document.getElementById(id);
        if (element) observer.observe(element);
      }
    }
    const onScroll = () => {
      if (!scroller) return;
      const start = scroller.scrollTop <= 0;
      const end =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (start === atStart && end === atEnd) return;
      atStart = start;
      atEnd = end;
      resolve();
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [navRef]);
  return active;
}
