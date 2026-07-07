# Web UI Design Guide

This document is the **Source of Truth** that the web SPA's code comments point
to when they say `DESIGN.md`. It records the design tokens and layout/component
conventions that are *already* in the code — it codifies the current state, it
does not propose new design. When a convention changes, change the code and this
document together.

Scope: the `web/` SPA only. (This is **not** the external "canon" docs of issue
#74, which are a separate effort.)

Stack: React + TanStack Router/Query, Tailwind CSS, and a small set of
[shadcn/ui](https://ui.shadcn.com) primitives.

---

## Design tokens

Tokens live as CSS custom properties in [`src/index.css`](./src/index.css) and
are surfaced to Tailwind through [`tailwind.config.js`](./tailwind.config.js).
Use the Tailwind utility (`bg-background`, `text-muted-foreground`, …) rather
than reaching for the raw HSL values.

### Color palette

The neutral shell is based on the shadcn/ui slate scale, with LoopHub's primary
interaction color set to a blue-purple theme. Colors are stored as bare HSL
channels (`H S% L%`) and wrapped with `hsl(var(--token))` in the Tailwind
config, so opacity modifiers (`bg-primary/90`) work.

| Token | Tailwind name | Role |
|-------|---------------|------|
| `--background` / `--foreground` | `background` / `foreground` | Page base + body text |
| `--card` / `--card-foreground` | `card` / `card-foreground` | Raised surfaces (sidebar) |
| `--primary` / `--primary-foreground` | `primary` / `primary-foreground` | Primary action color and readable foreground |
| `--primary-hover` / `--primary-active` | `primary-hover` / `primary-active` | Primary action interaction states |
| `--primary-subtle` / `--primary-border` | `primary-subtle` / `primary-border` | Selected-state fills, themed badges, and primary borders |
| `--link` | `link` | Links; aligned to the blue-purple primary family |
| `--secondary` / `--secondary-foreground` | `secondary` / `secondary-foreground` | Secondary buttons |
| `--muted` / `--muted-foreground` | `muted` / `muted-foreground` | Muted backgrounds + de-emphasized text |
| `--accent` / `--accent-foreground` | `accent` / `accent-foreground` | Hover/active highlight, derived from the primary subtle theme |
| `--destructive` / `--destructive-foreground` | `destructive` / `destructive-foreground` | Errors, conflicts, dangerous actions |
| `--border` / `--input` / `--ring` | `border` / `input` / `ring` | Borders, inputs, focus ring |

Outcome badge tones (`merged`, `review-passed`, `review-changes`,
`review-rereview`, `conflict`, `cost-stopped`) use Tailwind's built-in palette
directly. Active/open work-state tones (`open`, `mergeable`, `working`,
`agent`) use the primary theme tokens — see [Badge tones](#badge-tones).

### Light / dark theme

Theming is **class-based** (`darkMode: ["class"]`). The `:root` block holds the
light values; the `.dark` block overrides them. Switching themes means toggling
the `dark` class on `<html>` — the tokens cascade automatically, so components
never branch on theme.

The header **theme toggle** (`components/theme-toggle.tsx`) flips the class via
`lib/theme.ts`, which persists the choice in `localStorage` (`lh_theme`). On
first visit the initial theme follows the OS `prefers-color-scheme`; an inline
guard in `index.html` applies the class before first paint to avoid a flash of
the wrong theme (FOUC). Keep that inline guard in sync with
`resolveInitialTheme()`.

### Radius

`--radius: 0.5rem` is the single radius source. Tailwind derives
`rounded-lg`/`-md`/`-sm` from it (`var(--radius)`, `-2px`, `-4px`). Pills use
`rounded-full` (badges).

### Content width

`max-w-content` = **60rem**. Primary content columns are centered with
`mx-auto max-w-content` so wide viewports don't stretch lines. The repo
dashboard is the reference usage.

---

## Layout

### App shell

The shell is a fixed sidebar plus a scrolling main column with a breadcrumb
header ([`src/components/app-layout.tsx`](./src/components/app-layout.tsx),
[`app-sidebar.tsx`](./src/components/app-sidebar.tsx)).

| Dimension | Value | Where |
|-----------|-------|-------|
| Sidebar width | `w-64` | `app-sidebar.tsx` |
| Header height | `h-14` | `app-layout.tsx` (content header) and `app-sidebar.tsx` (brand row) — kept equal so they align |
| Shell | `h-screen w-full overflow-hidden` | `app-layout.tsx` |
| Main content padding | `p-6` | `app-layout.tsx` `<main>` |

The sidebar is `shrink-0` and the main column is `min-w-0 flex-1`; only `<main>`
scrolls (`overflow-y-auto`).

#### Sidebar section dividers

The sidebar's vertical sections (nav / repo list+Archived+herdr sessions /
footer) are separated by a single-pixel `border` token, applied as `border-b`
on the section above (nav) or `border-t` on the section below (footer) —
whichever side owns the section's own wrapper element. This is the same token
`divide-y` uses for in-list row separators, so section boundaries and row
boundaries read as one consistent line weight/color across light and dark
themes.

Within the repo list+Archived+herdr sessions section, the herdr "Agents"
sub-section (`SidebarHerdrSessions`) applies the same `border-t` token on its
own wrapper when it renders. Since that component returns `null` when there
are no herdr sessions to show, the divider only ever appears alongside the
content it separates.

### Dashboard sections

The repo dashboard (`/r/:owner/:repo`) shows the "now" sections — **Open PRs**
and **Open Issues** — each rendered through the generic
[`DashboardSection`](./src/components/dashboard-section.tsx).

- Each section lists at most **`SECTION_LIMIT` = 20** items
  ([`src/queries/dashboard.ts`](./src/queries/dashboard.ts)). The same constant
  is passed as `per_page`, so the API itself is capped.
- When a section has a dedicated list view, a **"See all"** link sits below the
  list (bottom-aligned, muted) linking to the full list route.
- Sections stack with `gap-8` inside the `mx-auto max-w-content` column.

---

## Components

### shadcn/ui primitives

Only the primitives actually used by the shell are vendored, each kept minimal
(no unused variants). They live under
[`src/components/ui/`](./src/components/ui/) and use `class-variance-authority`
(cva) for variants and `cn()` for class merging.

- **Button** ([`ui/button.tsx`](./src/components/ui/button.tsx)) — variants
  `default` (primary blue-purple), `ghost`, `secondary`; sizes `default` (`h-9`),
  `sm` (`h-8`), `icon` (`h-9 w-9`). Default+default is the standard action
  button.
- **Badge** ([`ui/badge.tsx`](./src/components/ui/badge.tsx)) — status pill;
  tones below.
- **Breadcrumb** ([`ui/breadcrumb.tsx`](./src/components/ui/breadcrumb.tsx)) —
  segment display only; see [Breadcrumbs](#breadcrumbs).

Add a new primitive only when the shell needs it, and keep it trimmed to the
variants in use.

### Badge tones

`Badge` takes a `tone` (default `closed`). Outcome tones keep their established
semantic colors, while active/open work-state tones use the primary theme. The
tone for a given issue/PR is computed by the pure helpers in
[`src/lib/badges.ts`](./src/lib/badges.ts) (`issueBadges`, `pullBadges`), not
chosen ad hoc at the call site.

| Tone | Meaning | Color |
|------|---------|-------|
| `open` | Open issue | Primary themed outline + tint |
| `closed` | Closed issue / closed PR (also the default) | Muted outline |
| `merged` | Merged PR | Purple outline |
| `review-passed` | PR review `PASSED` | Green outline |
| `review-changes` | PR review `CHANGES_REQUESTED` | Destructive outline |
| `review-rereview` | PR review `READY_FOR_RE_REVIEW` | Amber outline |
| `review-commented` | PR review `COMMENTED` | Muted outline |
| `conflict` | Open PR with `mergeable_state: conflict` | Destructive outline |
| `mergeable` | Open PR with `mergeable_state: clean` | Primary themed outline + tint |
| `working` | Open PR with active or dirty worktree work | Primary themed outline + tint |
| `cost-stopped` | Open PR stopped after exceeding cost limit | Destructive outline + tint |
| `agent` | Assigned agent session (`@name`) | Primary themed outline + tint |

Badges are compact pills (`rounded-full border`, `text-[11px]`). Work-state and
cost-stopped tones add a subtle fill so active states stand out without changing
layout.

---

## State patterns

List/section views handle the four TanStack Query states with a consistent
look. `DashboardSection` is the reference implementation; `app-sidebar.tsx`
follows the same shapes.

| State | Pattern |
|-------|---------|
| **Loading** | Inline row: `<Loader2 className="size-4 animate-spin" /> Loading…` in `text-sm text-muted-foreground`. |
| **Error** | `rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive`, message `Failed to load.` plus the error message when available. |
| **Empty** | Dashed placeholder: `rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground` with a section-specific empty text. |
| **Loaded** | `ul` with `divide-y rounded-md border`; one row per item. |

Prefer a static spinner + text over animated skeletons for now (see
[Known gaps](#known-gaps)).

---

## Breadcrumbs

The app-shell breadcrumb renders **plain path segments only**: a label and an
optional link per segment, derived from the pathname by the pure
[`crumbsForPath`](./src/lib/breadcrumb.ts) helper and displayed with the
[breadcrumb primitives](./src/components/ui/breadcrumb.tsx) in
[`app-breadcrumb.tsx`](./src/components/app-breadcrumb.tsx). The last segment is
the current page (no link, `aria-current="page"`), separated by a chevron.

The **rich dropdown breadcrumb** (switch repo/section from the crumb itself) is
intentionally **out of scope** for the shell and tracked as **issue #149**. The
breadcrumb primitives deliberately omit dropdown affordances for now.

---

## Known gaps

Deliberately not addressed yet; listed so the gap is explicit, not forgotten.

- **Responsive layout** — the shell assumes a desktop width; the fixed `w-64`
  sidebar has no mobile/collapsed treatment.
- **Accessibility** — beyond breadcrumb `aria-current` and the focus ring, no
  systematic a11y pass (focus traps, keyboard nav, contrast audit).
- **Skeletons** — loading uses a spinner + text rather than content-shaped
  skeleton placeholders.
