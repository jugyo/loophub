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

This is the shadcn/ui default **slate** theme. Colors are stored as bare HSL
channels (`H S% L%`) and wrapped with `hsl(var(--token))` in the Tailwind
config, so opacity modifiers (`bg-primary/90`) work. A v1 design-token port is
out of scope.

| Token | Tailwind name | Role |
|-------|---------------|------|
| `--background` / `--foreground` | `background` / `foreground` | Page base + body text |
| `--card` / `--card-foreground` | `card` / `card-foreground` | Raised surfaces (sidebar) |
| `--primary` / `--primary-foreground` | `primary` / `primary-foreground` | Primary action; GitHub-style green (`#1f883d` light, `#238636` dark) |
| `--secondary` / `--secondary-foreground` | `secondary` / `secondary-foreground` | Secondary buttons |
| `--muted` / `--muted-foreground` | `muted` / `muted-foreground` | Muted backgrounds + de-emphasized text |
| `--accent` / `--accent-foreground` | `accent` / `accent-foreground` | Hover/active highlight |
| `--destructive` / `--destructive-foreground` | `destructive` / `destructive-foreground` | Errors, conflicts, dangerous actions |
| `--border` / `--input` / `--ring` | `border` / `input` / `ring` | Borders, inputs, focus ring |

Badge accent colors (green/purple/amber/violet) are the exception: they use
Tailwind's built-in palette directly rather than theme tokens — see
[Badge tones](#badge-tones).

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
  `default` (primary green), `ghost`, `secondary`; sizes `default` (`h-9`),
  `sm` (`h-8`), `icon` (`h-9 w-9`). Default+default is the standard action
  button.
- **Badge** ([`ui/badge.tsx`](./src/components/ui/badge.tsx)) — status pill;
  tones below.
- **Breadcrumb** ([`ui/breadcrumb.tsx`](./src/components/ui/breadcrumb.tsx)) —
  segment display only; see [Breadcrumbs](#breadcrumbs).

Add a new primitive only when the shell needs it, and keep it trimmed to the
variants in use.

### Badge tones

`Badge` takes a `tone` (default `closed`). Tones mirror the v1 UI palette for
parity. The tone for a given issue/PR is computed by the pure helpers in
[`src/lib/badges.ts`](./src/lib/badges.ts) (`issueBadges`, `pullBadges`), not
chosen ad hoc at the call site.

| Tone | Meaning | Color |
|------|---------|-------|
| `open` | Open issue | Green outline |
| `closed` | Closed issue / closed PR (also the default) | Muted outline |
| `merged` | Merged PR | Purple outline |
| `review-passed` | PR review `PASSED` | Green outline |
| `review-changes` | PR review `CHANGES_REQUESTED` | Destructive outline |
| `review-rereview` | PR review `READY_FOR_RE_REVIEW` | Amber outline |
| `review-commented` | PR review `COMMENTED` | Muted outline |
| `conflict` | Open PR with `mergeable_state: conflict` | Destructive outline |
| `agent` | Assigned agent session (`@name`) | Violet, filled tint |

Badges are outline pills (`rounded-full border`, `text-[11px]`) except `agent`,
which adds a faint fill to stand out as an actor.

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
