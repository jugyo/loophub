// Breadcrumb skeleton for the app shell. Renders path segments only; the rich
// dropdown breadcrumb from DESIGN.md § Breadcrumbs is out of scope (issue #149).

import { Link, useRouterState } from "@tanstack/react-router";
import { useDetailTitle } from "@/components/detail-title";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { crumbsForPath } from "@/lib/breadcrumb";
import { cn } from "@/lib/utils";

export function AppBreadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsForPath(pathname);
  const { title, bodyVisible } = useDetailTitle();
  // Reveal the detail title only once the body heading has scrolled out of view.
  const showTitle = title != null && !bodyVisible;

  return (
    <Breadcrumb>
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, i) => (
          <BreadcrumbItem key={`${crumb.label}-${i}`}>
            {crumb.href ? (
              <Link to={crumb.href} className="hover:text-foreground">
                {crumb.label}
              </Link>
            ) : (
              <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
            )}
            {i < crumbs.length - 1 && <BreadcrumbSeparator />}
          </BreadcrumbItem>
        ))}
        {title != null && (
          // The crumb grows into the remaining row width (flex-1) and the inner
          // span truncates only once it hits the container edge; min-w-0 lets it
          // shrink first under narrow widths so it never pushes out the leading
          // crumbs. The crumb reveals by sliding up from below + fading in, and
          // slides back down + fades out when the body heading returns into view.
          <BreadcrumbItem
            data-state={showTitle ? "visible" : "hidden"}
            aria-hidden={!showTitle}
            className={cn(
              "min-w-0 flex-1 transition-[transform,opacity] duration-300 ease-out",
              showTitle
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-1.5 opacity-0",
            )}
          >
            <BreadcrumbSeparator />
            <BreadcrumbPage className="min-w-0 truncate" title={title}>
              {title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
