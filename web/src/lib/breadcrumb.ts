// Derives breadcrumb segments from the current pathname. Pure + dependency-free
// so it is unit-testable without a router. Dropdowns / rich labels are out of
// scope for the app shell (DESIGN.md § Breadcrumbs, issue #149); this returns
// plain label+href segments.

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
 *   "/settings"                      -> [Home, Settings]
 *   "/stats"                         -> [Home, Stats]
 *   "/stats/db"                      -> [Home, Stats, DB Stats]
 *   "/stats/sessions"                -> [Home, Stats, Agent sessions]
 *   "/r/me/proj"                     -> [Home, me/proj]
 *   "/r/me/proj/issues/12"           -> [Home, me/proj, #12]
 *   "/r/me/proj/pulls/3"             -> [Home, me/proj, #3]
 *   "/r/me/proj/merged"              -> [Home, me/proj, Merged]
 *   "/r/me/proj/settings"            -> [Home, me/proj, Settings]
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

  if (parts[0] === "settings") {
    crumbs.push({ label: "Settings" });
    return crumbs;
  }

  if (parts[0] === "stats") {
    crumbs.push({ label: "Stats", href: "/stats" });
    const statsSections: Record<string, string> = {
      db: "DB Stats",
      sessions: "Agent sessions",
    };
    const section = parts[1];
    if (section && statsSections[section]) {
      crumbs.push({ label: statsSections[section] });
    }
    const last = crumbs[crumbs.length - 1];
    if (last) last.href = undefined;
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
    const detailSections = new Set(["issues", "pulls"]);
    const sections: Record<string, string> = {
      merged: "Merged",
      settings: "Settings",
    };

    if (section && detailSections.has(section) && number) {
      crumbs.push({ label: `#${number}` });
    } else if (section && sections[section]) {
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
