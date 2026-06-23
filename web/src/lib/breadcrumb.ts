// Derives breadcrumb segments from the current pathname. Pure + dependency-free
// so it is unit-testable without a router. Dropdowns / rich labels are out of
// scope for the app shell (issue #149); this returns plain label+href segments.

export interface Crumb {
  label: string;
  /** Link target, or undefined for the current (last) segment. */
  href?: string;
}

/**
 * Build breadcrumb crumbs for a LoopHub v2 pathname.
 *
 * Examples:
 *   "/"                              -> [Home]
 *   "/archived"                      -> [Home, Archived]
 *   "/r/me/proj"                     -> [Home, me/proj]
 *   "/r/me/proj/issues"              -> [Home, me/proj, Issues]
 *   "/r/me/proj/issues/12"           -> [Home, me/proj, Issues, #12]
 *   "/r/me/proj/pulls/3"             -> [Home, me/proj, Pull requests, #3]
 *   "/r/me/proj/merged"              -> [Home, me/proj, Merged]
 */
export function crumbsForPath(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Home", href: "/" }];
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return [{ label: "Home" }];
  }

  if (parts[0] === "archived") {
    crumbs.push({ label: "Archived" });
    return crumbs;
  }

  if (parts[0] === "r" && parts[1] && parts[2]) {
    const owner = parts[1];
    const repo = parts[2];
    const repoHref = `/r/${owner}/${repo}`;
    const full = `${owner}/${repo}`;
    crumbs.push({ label: full, href: repoHref });

    const section = parts[3];
    const number = parts[4];
    const sections: Record<string, string> = {
      issues: "Issues",
      pulls: "Pull requests",
      merged: "Merged",
    };

    if (section && sections[section]) {
      const sectionHref = `${repoHref}/${section}`;
      crumbs.push({
        label: sections[section],
        href: number ? sectionHref : undefined,
      });
      if (number) crumbs.push({ label: `#${number}` });
    }
  }

  // Mark the final crumb as current (no link).
  const last = crumbs[crumbs.length - 1];
  if (last) last.href = undefined;
  return crumbs;
}
