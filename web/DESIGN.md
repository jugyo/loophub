# Web UI Design Guide

This document is the **Source of Truth** that the web SPA's code comments point
to when they say `DESIGN.md`. It records the design tokens and layout/component
conventions that are *already* in the code, together with approved guidelines
for adding or reviewing UI. When this document describes current behavior, keep
the code and documentation in sync. A guideline may identify a legacy gap; fix
that gap in a focused implementation change rather than describing it as
already implemented or expanding an unrelated change.

Scope: the `web/` SPA only. (This is **not** the external "canon" docs of issue
#74, which are a separate effort.)

Stack: React + TanStack Router/Query, Tailwind CSS, and a small set of
[shadcn/ui](https://ui.shadcn.com) primitives.

---

## Design tokens

Runtime theme tokens live in [`src/lib/theme.ts`](./src/lib/theme.ts), are
applied as CSS custom properties on `<html>`, and are surfaced to Tailwind
through [`tailwind.config.js`](./tailwind.config.js). Use the Tailwind utility
(`bg-background`, `text-muted-foreground`, …) rather than reaching for the raw
HSL values. [`src/index.css`](./src/index.css) keeps only the first-paint
LoopHub Light/Dark fallback tokens and shared non-theme styles.

### Color palette

The neutral shell is based on the shadcn/ui slate scale, with LoopHub's primary
interaction color set to a blue-purple theme. Colors are stored as bare HSL
channels (`H S% L%`) and wrapped with `hsl(var(--token))` in the Tailwind
config, so opacity modifiers (`bg-primary/90`) work.

Dark-theme primary button states and supporting text tokens are covered by
contrast assertions in `src/lib/theme.test.ts`. Keep those checks green when
adjusting dark color tokens.

| Token | Tailwind name | Role |
|-------|---------------|------|
| `--background` / `--foreground` | `background` / `foreground` | Page base + body text |
| `--card` / `--card-foreground` | `card` / `card-foreground` | Raised surfaces (application header and cards) |
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

### UI themes

Theming is **class-based** (`darkMode: ["class"]`). Theme definitions live in
`src/lib/theme.ts`; each theme has a stable persisted ID, a label, a light/dark
appearance, and a complete token set. The built-in set currently exposes eight
choices.
`light` and `dark` remain valid stored IDs in `localStorage` (`lh_theme`) for
existing users, but their reader-facing labels are `LoopHub (Light)` and
`LoopHub (Dark)`. Add a non-default theme by extending `THEMES` in
`src/lib/theme.ts`; the `Theme` union is derived from that array, and tests
assert every theme provides all required tokens.

The header **theme selector** (`components/theme-toggle.tsx`) applies themes via
`lib/theme.ts`, which sets `data-theme`, a `theme-*` class, and the `dark` class
for dark-appearance themes, then writes the selected theme's token values onto
`<html>`. Components should not branch on theme. On first visit the initial
theme follows the OS `prefers-color-scheme`; an inline guard in `index.html`
applies the persisted theme ID and stored light/dark appearance before first
paint. When the app module starts, `src/main.tsx` reapplies the selected
`theme.ts` token set before React renders.

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

### UI vocabulary

Use the terms below when discussing, designing, or reviewing the major UI
regions and page types. They name the current structure; detailed layout and
component conventions remain in the sections that follow.

| Term | Role and scope / representative route | Primary implementation |
|------|-----------------------------------------|------------------------|
| **Application header** | Application-wide header shown above every route. It contains global navigation and controls that are not owned by one repository. Use this semantic term instead of the position-based “top bar.” | `AppTopbar` in [`src/components/app-topbar.tsx`](./src/components/app-topbar.tsx), composed by `AppLayout` |
| **Repository navigation bar** | Repository-scoped section navigation shown below the application header on routes with `:owner` and `:repo`, such as `/r/:owner/:repo`. It is not an application-wide header. | `RepoTopbar` in [`src/components/repo-topbar.tsx`](./src/components/repo-topbar.tsx), composed by `AppLayout` |
| **Application status bar** | Application-wide status region fixed below the main content on every route. It reports shared runtime and environment information. | `AppStatusbar` in [`src/components/app-statusbar.tsx`](./src/components/app-statusbar.tsx), composed by `AppLayout` |
| **Issue list** | Repository-scoped list and filtering page for issues. The canonical repository entry is `/r/:owner/:repo`; `/r/:owner/:repo/issues` is also supported. | `IssueList` in [`src/components/issue-list.tsx`](./src/components/issue-list.tsx), mounted by `routes/repo.tsx` and `routes/repo-issues.tsx` |
| **Issue detail page** | Repository-scoped page for one issue at `/r/:owner/:repo/issues/:number`. | `IssueDetail` in [`src/components/issue-detail.tsx`](./src/components/issue-detail.tsx), mounted by `routes/issues.tsx` |
| **Pull request detail page** | Repository-scoped page for one pull request at `/r/:owner/:repo/pulls/:number`. | `PullDetail` in [`src/components/pull-detail.tsx`](./src/components/pull-detail.tsx), mounted by `routes/pulls.tsx` |
| **Application settings** | Application-wide configuration page at `/settings`; its settings are not limited to the repository currently selected in the shell. | `SettingsPage` in [`src/components/settings-page.tsx`](./src/components/settings-page.tsx), mounted by `routes/settings.tsx` |
| **Repository settings** | Configuration page for one repository at `/r/:owner/:repo/settings`. | `RepoSettingsPage` in [`src/components/repo-settings-page.tsx`](./src/components/repo-settings-page.tsx), mounted by `routes/repo-settings.tsx` |

`AppLayout` in [`src/components/app-layout.tsx`](./src/components/app-layout.tsx)
defines how the application header and status bar surround route content and
adds repository navigation on repository routes; see [App shell](#app-shell)
for dimensions and scrolling behavior. The complete route tree is assembled in
[`src/router.tsx`](./src/router.tsx). When a named region or page changes
responsibility, route, or structure, update its code and this glossary
together, following this document's Source of Truth policy.

### Component debug mode

The application header exposes a component debug mode beside the theme picker.
When enabled, `ComponentDebugOverlay` outlines every visible element carrying a
`data-debug-component` attribute and provides its React component name plus a
copy action. Hovering a truncated label shows the full component name in a
tooltip so narrow controls stay identifiable. Markers live on:

- Shell regions and major route/page components (home, repo, issues, pulls,
  agents, inbox, stats, settings, workflows, scheduled tasks, and similar
  screens)
- Mid-size detail/sidebar sections (for example Sessions, Work duration,
  GitHub PR status, Handoffs, Agents, Workflow run, Worktree, Linked pull
  summary)
- Purpose-named interactive controls and wrappers (for example
  `CreateIssueButton`, `NewWorkspaceButton`, `ThemeToggle`,
  `ComponentDebugToggle`, `NotificationCenter`, `RepoSwitcher`,
  `RepositorySearch`, `HerdrAgentInput`, `AgentModelPicker`)
- Dropdown content surfaces under `ui/` that own a root DOM node
  (`DropdownMenuContent`, `DropdownMenuSubContent`)

Shared primitives such as `ui/Button` and `ui/Badge` do **not** set a generic
marker by default. Callers may pass `data-debug-component` when a purpose-
specific name is useful; otherwise leave them unmarked so the overlay is not
flooded with repeated `Button` / `Badge` labels.

Names match the React component export (PascalCase). Prefer markers on named
wrappers or role-specific roots over generic primitive names. Nested markers
may coexist with a page-level marker. This keeps the mapping stable across
production and development builds without reading React internals or changing
component layout.

Existing tools were considered before choosing this approach:

- React DevTools provides the complete component tree, props, and state, but it
  requires a browser extension or a separate standalone panel and does not
  provide LoopHub's always-visible, copyable all-component overview.
- React Scan focuses on render-performance diagnostics. Its automatic React
  instrumentation and performance UI are broader than this mode's component
  name and box requirements.
- TanStack Devtools Source Inspector highlights one hovered element and opens
  its source location. It depends on development-only Vite source injection,
  whereas this mode must work from the normal LoopHub UI on every route.

The local DOM-marker overlay is therefore the smallest maintainable option: it
adds no runtime dependency, exposes only intentionally named major components,
and keeps props, state, and performance data out of scope.

### App shell

The shell places a scrolling main column between a fixed application header and
application status bar. Repository routes also show a repository navigation
bar ([`src/components/app-layout.tsx`](./src/components/app-layout.tsx),
[`src/components/repo-topbar.tsx`](./src/components/repo-topbar.tsx)).

| Dimension | Value | Where |
|-----------|-------|-------|
| Application header height | `h-14` | `app-topbar.tsx` |
| Repository navigation height | `h-11` | `repo-topbar.tsx` |
| Status bar height | `h-8` | `app-statusbar.tsx` |
| Shell | `h-screen w-full overflow-hidden` | `app-layout.tsx` |
| Main content padding | `px-4 pt-6 sm:px-6` | `app-layout.tsx` `<main>` |

The application header, repository navigation, and application status bar are
`shrink-0`; the main column is `min-w-0 flex-1`, and only `<main>` scrolls
(`overflow-y-auto`). Routes outside a repository omit the repository
navigation bar entirely.

#### Shell dividers

The application header and repository navigation are separated by a
single-pixel `border` token (`border-b`). This is the same token `divide-y` uses
for in-list row separators, so section boundaries and row boundaries read as
one consistent line weight/color across light and dark themes.

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

### Resource popovers

A **resource popover** is a compact, non-modal panel anchored to a trigger. It
adds identifying details, supporting metadata, and contextual actions without
making the user leave the current page. These guidelines apply whether the
panel opens from pointer hover, keyboard focus, or click.

The current Web UI has two resource-popover patterns:

- [`IssuePopover`](./src/components/dashboard-rows.tsx), used by the shared
  `IssueRow` on the home page, repository dashboard, and issue list, previews an
  issue's state, metadata, description, and Herdr context.
- [`PullPopover`](./src/components/linked-pull-summary.tsx), used by the shared
  `LinkedPullSummaryRow` on those issue lists and on issue detail pages,
  previews a linked PR's status, runtime metrics, and contextual actions.

This inventory identifies the existing surfaces; it does not assert that every
legacy instance already satisfies every guideline below. Apply the checklist to
new or reviewed popovers, and address legacy gaps through separately scoped UI
changes rather than a bulk migration.

Both are hover-and-focus popovers driven by `useHoverPopover`. A future
click-triggered panel is also in scope when it serves the same supplementary
resource-detail purpose. A control's visual shape or use of absolute
positioning does not make it a resource popover:

- **Menus are out of scope.** Notification, theme, filter, agent/model, and PR
  debug menus present choices or commands and follow menu selection and keyboard
  conventions instead.
- **Modals are out of scope.** Repository switching, forms, lightboxes, debug
  data, diff views, and other dialogs interrupt the page, use a backdrop, and
  own focus until dismissed.
- **Tooltips are out of scope.** A tooltip supplies a short label or hint and
  never contains resource structure, navigation, or actions.

#### Activation and dismissal

The content hierarchy does not change with the activation method. Pointer and
keyboard users must be able to reach the same navigation and actions, and
opening one panel must not turn its trigger or an entire row into a competing
navigation target.

- **Hover opens after a delay.** Pointer hover waits `HOVER_POPUP_DELAY_MS =
  300` ms (the single source of truth in
  [`src/lib/use-hover-popover.ts`](./src/lib/use-hover-popover.ts)) before the
  popover appears.
- **Leaving during the delay cancels the open.** If the pointer leaves before
  the delay elapses, the pending open is cancelled and the popover never shows —
  not even for a frame. Once open, moving from the trigger into the popover must
  keep it available.
- **Keyboard focus opens immediately.** Focus is intentional, so it opens the
  popover with no delay. Focus may move into links and actions within the panel;
  `Escape` and blur to an element outside the trigger/popover region close it.
- **Click opens immediately.** For a click-triggered resource popover, the same
  control toggles the panel. `Escape`, an outside click, or completed navigation
  dismisses it; it remains non-modal and does not trap focus.

Reuse `useHoverPopover` for the hover delay, pending-open cancellation, immediate
focus open, and shared `close()` operation. The caller still owns blur
containment and `Escape` handling: detect when focus leaves the combined
trigger/popover region or when `Escape` is pressed, then call `close()`.

#### Content hierarchy and navigation

Organize a resource popover into three predictable regions:

1. **Header:** identify the subject with its stable ID and/or name, such as
   `Issue #42` or `PR #17`. When LoopHub has a detail page for the resource, make
   that identifier the natural, standard-text navigation link in the header.
   Do not repeat the same destination as a large button in the action region.
2. **Body:** put status and the most decision-relevant facts first, then
   secondary metadata and a short description. Use labels, badges, definition
   lists, truncation, and wrapping consistently so values remain scannable; omit
   empty sections instead of filling the panel with placeholders unless the
   absence itself matters.
3. **Action region:** place contextual operations after the information they
   depend on and separate the region with spacing or a border. Keep the number
   of actions small; a popover is not a replacement for the detail page.

The header-link convention generalizes the linked-PR improvement from #1334:
navigation to the resource is part of identification, while actions are things
the user does in the resource's current context.

#### Action prominence

Choose emphasis from the action's meaning and importance, not from the desire
to make every available operation noticeable:

- **Primary** is reserved for the single most important task-advancing operation
  in the current context. Merely opening the resource's detail page is
  navigation, so present it as the header link rather than a primary-color
  button.
- **Secondary** suits useful contextual operations that do not define the main
  task, such as `Open in Herdr`.
- **Ghost or link styling** suits low-emphasis navigation and optional utility
  actions.
- **Destructive** is reserved for actions with destructive consequences. Keep
  it visually distinct, label the consequence plainly, and do not place it
  where it can be mistaken for routine navigation.

Do not show two actions with equal primary emphasis. Preserve visible disabled,
pending, and error behavior for operations that may be unavailable or fail.

#### Density and visual style

- Use a compact width appropriate to the content, a clear header/body/action
  stack, and enough internal padding and section spacing to keep dense metadata
  readable. Avoid page-scale layouts and large empty areas.
- Use the theme surface and foreground tokens (`bg-background`,
  `text-foreground`) for an opaque panel, plus the shared `border`,
  `rounded-md`, and `shadow-lg` treatment. Use `muted-foreground` for supporting
  labels and metadata; do not hard-code light- or dark-theme colors.
- Use dividers selectively to explain hierarchy: typically below the header or
  above a distinct action/description region. Avoid boxing every field.
- Keep links and controls keyboard-visible with the shared focus ring. Give the
  panel an accessible name tied to the resource, and preserve meaningful link,
  button, and status semantics within it.

#### New/reviewed popover checklist

- Is this supplementary resource context, rather than a menu, modal, or tooltip?
- Does every activation method expose the same content and dismissal paths?
- Does hover/focus behavior reuse `useHoverPopover` for its delay, immediate
  focus open, and `close()`, with caller-owned `Escape` and blur containment?
- Does the header identify the resource and link its ID/name when a detail page
  exists, without duplicating that navigation as a primary button?
- Are body facts ordered by decision value and actions separated and kept few?
- Do primary, secondary, ghost/link, and destructive styles match action meaning?
- Does the panel use opaque theme tokens, compact spacing, and visible keyboard
  focus in both light and dark themes?

---

## State patterns

List/section views handle the four TanStack Query states with a consistent
look. `DashboardSection` is the reference implementation; app-shell controls
use the same loading and error language where they fetch data.

| State | Pattern |
|-------|---------|
| **Loading** | Inline row: `<Loader2 className="size-4 animate-spin" /> Loading…` in `text-sm text-muted-foreground`. |
| **Error** | `rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive`, message `Failed to load.` plus the error message when available. |
| **Empty** | Dashed placeholder: `rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground` with a section-specific empty text. |
| **Loaded** | `ul` with `divide-y rounded-md border`; one row per item. |

Prefer a static spinner + text over animated skeletons for now (see
[Known gaps](#known-gaps)).

---

## Known gaps

Deliberately not addressed yet; listed so the gap is explicit, not forgotten.

- **Accessibility** — beyond the existing navigation semantics and focus rings,
  no systematic a11y pass (focus traps, keyboard nav, contrast audit).
- **Skeletons** — loading uses a spinner + text rather than content-shaped
  skeleton placeholders.
