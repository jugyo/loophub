import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { Badge as BadgeData } from "@/lib/badges";
import { cn } from "@/lib/utils";

/**
 * Shared id + title block for issue/PR detail headers. Owning the spacing here
 * keeps the id→title margin and header layout identical across both pages.
 */
export function DetailHeaderTitle({
  kind,
  number,
  title,
  titleSource,
  titleRef,
  titleAside,
}: {
  kind: "Issue" | "PR";
  number: number;
  title: string;
  /**
   * Shown after the id when the title belongs to another item: a PR has no title of its own and
   * shows its linked issue's, so this names that issue next to the PR's own number.
   */
  titleSource?: ReactNode;
  /** Observed by {@link DetailStickyHeader} to know when the title left the viewport. */
  titleRef?: RefObject<HTMLDivElement | null>;
  /** Rendered beside the title, e.g. the issue's dependency summary. */
  titleAside?: ReactNode;
}) {
  return (
    <div
      ref={titleRef}
      data-debug-component="DetailHeaderTitle"
      className="flex min-w-0 flex-col gap-1"
    >
      <span className="text-sm font-medium text-muted-foreground">
        {kind} #{number}
        {titleSource ? <> · {titleSource}</> : null}
      </span>
      {titleAside ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {titleAside}
        </div>
      ) : (
        <h1 className="text-2xl font-semibold">{title}</h1>
      )}
    </div>
  );
}

/**
 * Compact header (#2033) shown while the page-top title of
 * {@link DetailHeaderTitle} is scrolled out of view, so a long issue/PR thread
 * never loses which item it belongs to. One line, plus a second one when the
 * page passes `secondRow`.
 *
 * The wrapper is a zero-height sticky box so the bar overlays the scrolled
 * content instead of reserving space at the top of the page; it must therefore
 * be rendered as a child of an element that spans the whole scrolled column,
 * not inside the header block itself. Its width follows that parent, so on a
 * page with a sidebar it belongs to the main column rather than the full page
 * width (#2089). The scroll area reserves the bar's height as scroll-padding
 * (app-layout.tsx) so anything scrolled to lands below it.
 */
export function DetailStickyHeader({
  kind,
  number,
  title,
  titleSource,
  badges,
  secondRow,
  titleRef,
}: {
  kind: "Issue" | "PR";
  number: number;
  title: string;
  /** Same as {@link DetailHeaderTitle}'s. */
  titleSource?: ReactNode;
  /** Status shown by the page itself (stateBadge / pullDetailBadges), reused verbatim. */
  badges: BadgeData[];
  /**
   * Compact content for a second line, or null for a one-line bar (h-11). The two-line bar is h-16
   * and whatever the page stacks under it must account for that.
   */
  secondRow?: ReactNode;
  titleRef: RefObject<HTMLDivElement | null>;
}) {
  const visible = useScrolledPast(titleRef);
  return (
    // The bar is mounted only while it is shown so the page never carries a second copy of the
    // title/status text (duplicated for assistive tech and for text queries) while it is hidden.
    // -top-6 cancels the app shell's pt-6 (app-layout.tsx) so the bar sits flush against the top
    // of the scroll area instead of leaving a sliver of scrolled content above it.
    <div className="pointer-events-none sticky -top-6 z-20 h-0">
      {visible ? (
        // pointer-events-auto only on the bar itself: it is opaque, so a click landing on it must
        // not fall through to the content hidden behind it, while the zero-height wrapper around
        // it keeps passing clicks through.
        <div
          data-debug-component="DetailStickyHeader"
          className={cn(
            "pointer-events-auto flex flex-col bg-background/95 backdrop-blur",
            secondRow ? "h-16" : "h-11 border-b",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2",
              secondRow ? "h-9" : "h-11",
            )}
          >
            <span className="shrink-0 text-sm font-medium text-muted-foreground">
              {kind} #{number}
              {titleSource ? <> · {titleSource}</> : null}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {title}
            </span>
            {badges.map((b, i) => (
              <Badge
                key={`${b.tone}-${i}`}
                tone={b.tone}
                title={b.title}
                className="shrink-0"
              >
                {b.label}
              </Badge>
            ))}
          </div>
          {secondRow ? (
            <div className="flex flex-1 items-center">{secondRow}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * True once `ref`'s element is fully out of view. The root is the viewport: the
 * app scrolls inside <main>, whose overflow already clips the observed element,
 * so the intersection reflects the scroll position without threading the
 * scroll container's ref through every detail page.
 *
 * Exported for other bars that stack under this one (pull-section-tabs.tsx), so
 * they switch on the same title as the header rather than a second guess at it.
 */
export function useScrolledPast(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolledPast, setScrolledPast] = useState(false);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => {
      setScrolledPast(!entry.isIntersecting);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [ref]);
  return scrolledPast;
}
