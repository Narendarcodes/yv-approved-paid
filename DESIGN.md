# yv. design system

This is the design system the app actually ships. It is derived from the tokens and recipes in `apps/web` (introduced in the "Visual polish pass", commit `819c9b3`). When this file and the code disagree, the code is the source of truth: fix whichever is wrong in the same PR.

Not to be confused with `.agents/skills/stitch-design-taste/DESIGN.md`, which is a generic agent skill with its own zinc palette. yv. does not use that palette.

## 1. Brand principles

yv. should feel like a calm, serious tool, in the same class as Linear, Vercel or Notion, while staying recognisably yv.: warm paper instead of cold grey, ink instead of pure black, and one deep teal.

1. **Calm by default.** Warm off-white canvas, white surfaces, hairline borders, two shadow levels. Nothing glows, bounces or shouts in the app.
2. **One accent.** Teal `#035E5E` marks the primary action, the current place and selected state. If everything is teal, nothing is.
3. **Colour means status.** Saturated colour is spent on the seven pipeline stages and on success/warning/danger feedback, not decoration.
4. **Ink-weight typography.** Hierarchy comes from size, weight and the mono micro-label, not from colour.
5. **Honest states.** Every async view has a skeleton, an empty state that says what to do next, and an error with a retry. Simulated (demo-mode) data is always labelled.
6. **Accessible is non-negotiable.** WCAG AA contrast for every text/background pair, keyboard focus everywhere, reduced motion respected.

The marketing landing page (`/`, `.landing` in `index.css`) may be more expressive (Instrument Serif display type, grain, marquee, dot grid). Those recipes stay scoped to `.landing` and never appear inside the app shell.

## 2. Where the tokens live

| What | File | Notes |
|---|---|---|
| Colour, font, radius, shadow, easing tokens | `apps/web/src/index.css`, `@theme { … }` | Tailwind v4 theme: every `--color-x` becomes `bg-x` / `text-x` / `border-x` utilities |
| Spacing names for hand-written CSS | `apps/web/src/index.css`, `:root { --space-* }` | Tailwind spacing utilities are on the same 4px grid |
| Component recipes (`.card`, `.btn-*`, `.status-chip`, `.nav-item`, `.table-*`, `.skeleton`, `.micro-label`, `.t-*`) | `apps/web/src/index.css`, `@layer components` | Use these classes before inventing utilities |
| Motion keyframes + reduced-motion rules | `apps/web/src/index.css`, "Motion" section | |
| Status + platform vocabulary | `apps/web/src/components/status.tsx` | `StatusChip`, `StatusDot`, `stageOf()`, `PlatformIcon`, `PlatformIcons` |
| Platform labels + glyphs | `apps/web/src/lib/publishing.tsx` | `PLATFORMS`, `PLATFORM_ORDER`, `PlatformGlyph` |
| Chart colours | `apps/web/src/components/charts.tsx` | `TEAL`, `INK`, `RAMP` (mirror the CSS ramp tokens) |
| Async states | `apps/web/src/components/states.tsx` | `Skeleton`, `CardSkeleton`, `StatCardSkeleton`, `ListSkeleton`, `ErrorBanner`, `EmptyState` |
| Page and section headers, avatars | `apps/web/src/components/ui.tsx` | `PageHeader`, `SectionHeading`, `Avatar`, `UnassignedChip` |
| Toasts | `apps/web/src/components/toast.tsx` | `useToast()` |
| App shell, sidebar, mobile drawer | `apps/web/src/layouts/AppShell.tsx` | |
| Fonts | `apps/web/index.html` (Google Fonts link) | Outfit, Figtree, JetBrains Mono, Instrument Serif |

## 3. Colour

### Surfaces and text
| Token | Value | Role |
|---|---|---|
| `canvas` | `#F7F5F2` | App background (warm paper). Also the hover fill of secondary buttons |
| `surface` | `#FFFFFF` | Cards, panels, inputs, popovers |
| `cream` | `#EFEBE3` | Brand panels, media thumbnails. Not for body text areas (see contrast) |
| `ink` | `#171310` | Primary text, the selected segment, platform icon tiles. Never use `#000` |
| `umber` | `#6B645E` | Secondary text, meta, ghost button text |
| `label` | `#57534E` | Mono micro-labels, table heads, nav sections, chart axes |
| `line` | `rgba(28,25,23,.10)` | Default hairline border and dividers |
| `line-strong` | `rgba(28,25,23,.16)` | Hovered cards and inputs, secondary button border |

Neutral fills for hover and press are ink at low alpha (`rgba(28,25,23,.025–.06)`, or `bg-ink/[0.05]`), never a separate grey.

### Accent
| Token | Value | Role |
|---|---|---|
| `teal` | `#035E5E` | Primary buttons, links, focus ring, active nav rail, brand mark, scheduled stage |
| `teal-press` | `#024A4A` | Hover/pressed primary, active nav text, selection text |
| `on-accent` | `#FFFFFF` | Text and icons on teal |
| `tint` | `#E6F2F0` | Selected rows, active nav background, text selection, teal chips |

### Feedback
| Token | Value | Role |
|---|---|---|
| `success` | `#15803D` | Positive deltas, success chips and toasts |
| `warning` | `#B45309` | Warnings, "needs attention" |
| `danger` | `#B42318` | Errors, destructive buttons, negative deltas, failed |

Use them as text or icon colour, or as a 10% tint background (`bg-danger/10`, `.chip-danger`). Never as large solid fills, except `.btn-danger`.

### Pipeline status palette
Every project status and post status maps to one of seven stages via `stageOf()` in `components/status.tsx`. Each stage has a foreground (`st-<stage>`) and a background (`st-<stage>-bg`), and the dot uses the foreground.

| Stage | fg | bg | fg/bg contrast | Covers |
|---|---|---|---|---|
| idea | `#57534E` | `#F0EEEA` | 6.6:1 | IDEA, APPROVED_CONCEPT |
| brief | `#2F5784` | `#E9F0F7` | 6.5:1 | ASSIGNED, WAITING_FOR_INPUTS, INPUTS_READY |
| production | `#8A4B0C` | `#FBF0E1` | 6.0:1 | IN_PROGRESS, REVISION_REQUESTED, REVISION_IN_PROGRESS |
| review | `#6B3FA0` | `#F2EDF9` | 6.4:1 | FIRST_DRAFT_SUBMITTED, UNDER_REVIEW, REVISION_SUBMITTED |
| scheduled | `#035E5E` | `#E6F2F0` | 6.6:1 | APPROVED, SCHEDULED, post `scheduled` |
| live | `#2F6B1E` | `#ECF5E4` | 5.8:1 | PUBLISHED, post `published`/`live` |
| failed | `#B42318` | `#FDECEA` | 5.8:1 | post `failed` |
| neutral | `umber` | ink 5% | n/a | CLOSED, CANCELLED, unknown |

A new status must be added to `STAGE_OF` in `status.tsx`, not styled ad hoc.

### Data-viz ramp
Teal, light to dark: `ramp-0 #EEF1EF` (no data) · `ramp-1 #CFE5E1` · `ramp-2 #9CCBC4` · `ramp-3 #5FA69D` · `ramp-4 #2A7F78` · `ramp-5 #035E5E`. Used for heatmaps, bars and sparkline fills (`RAMP`, `rampColor()` in `charts.tsx`). Single-series lines are teal; comparisons use ink plus teal.

## 4. Typography

| Family | Token | Use |
|---|---|---|
| Outfit 400–700 | `--font-headline` / `font-headline` | Page titles, card titles, big numbers, brand mark |
| Figtree 400–600 | `--font-body` / `font-body` | All UI and body text (default on `html`) |
| JetBrains Mono 400–500 | `--font-mono` / `font-mono` | Micro-labels, table heads, nav sections, chips, deltas, IDs and timecodes |
| Instrument Serif | `--font-display` | Landing page only |

### Scale (classes in `index.css`)
| Class | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `.t-display` | 28 / 1.15 | 600 Outfit | -0.03em | Page title (`PageHeader`) |
| `.t-title`, `.card-title` | 15 / 1.3 | 600 Outfit | -0.01em | Card and section titles |
| `.t-body` | 14 / 1.5 | 400 Figtree | 0 | Body copy, inputs, buttons |
| `.t-meta` | 12 / 1.4 | 400 Figtree, `umber` | 0 | Timestamps, secondary facts |
| `.micro-label`, `.label` | 11 / 1.35 | 400–500 Mono, uppercase | 0.05–0.06em | Field labels and eyebrow labels (VERSION, TEAM, SCHEDULE) |
| `.nav-section` | 11 | Mono, uppercase | 0.1em | Sidebar group headings |
| `.table-head` | 10 | 500 Mono, uppercase | 0.05em | Table column headers |
| `.t-num` | contextual | 600 Outfit, tabular | -0.02em | KPIs and stage counts |

Rules: `html` sets `font-variant-numeric: tabular-nums`, so numbers line up in tables and counters. Paragraph measure is at most about 62ch (`PageHeader` subtitle). Use sentence case for UI copy; uppercase only through the mono label recipes.

## 5. Spacing, radius, elevation

**Spacing:** a 4px grid. `--space-1..12` = 4, 8, 12, 16, 20, 24, 32, 48px, which match Tailwind `1, 2, 3, 4, 5, 6, 8, 12`. Card padding is 20px (`p-5`), the card header is 56px tall with 20px side padding, the gap between cards is 16px (`gap-4`), and the page header bottom margin is 24px (`mb-6`).

**Radius**
| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 6px | Skeleton bars, small inline controls, links |
| `--radius-md` | 10px | Inputs, nav items, icon buttons, segmented control |
| `--radius-card` | 12px | Cards, buttons, focus ring, list skeletons |
| `--radius-lg` | 16px | Modals, large panels |
| `--radius-pill` | 999px | Status chips, chips, badges, avatars |

**Elevation: two levels only**
| Token | Use |
|---|---|
| `--shadow-1` (`shadow-card`) | Resting surfaces: cards, secondary buttons, the selected segment |
| `--shadow-card-hover` | Hovered interactive card (with `line-strong` border) |
| `--shadow-2` (`shadow-pop`) | Floating: popovers, menus, toasts, modals, mobile drawer |
| `--shadow-scrim` | Modal and drawer backdrop, ink at 45% |

Cards lift with border and shadow on hover, never with a translate.

## 6. Components

### Buttons (`.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`)
- 38px tall, 12px radius, 16px horizontal padding, 14px/500 Figtree, 16px icons with an 8px gap. Sizes: `.btn-xs` 32, `.btn-sm` 36, `.btn-lg` 44.
- **Primary** (teal) is used once per view, for the main next step. **Secondary** (white, `line-strong` border) is for everything else. **Ghost** is for toolbars and tertiary actions. **Danger** is only for destructive confirmation.
- Press: `scale(0.97)` with `--ease-press`. Disabled: 45% opacity, no pointer events.
- **Icon buttons:** `.icon-btn` is 36px (`.icon-btn-sm` 32px), umber, with an ink-tint hover, press `scale(0.92)`, and it always needs an `aria-label`.

### Status chips (`StatusChip`, `.status-chip`)
- A pill 22px tall with 8px padding and 12px/500 text, a 6px dot in `currentColor`, and stage fg on stage bg.
- `StatusChip` is the **only** way to render a project or post status. Pass `label` for compound states ("Partially published (1/2)").
- In dense views (calendar cells, legends) use `StatusDot` (6px). Never show colour alone without a label nearby or a tooltip.
- Plain chips (`.chip-teal|neutral|success|warning|danger`) are for tags and counts. They are 24px with mono 11px text, and are not for lifecycle status.

### Platform icons (`PlatformIcon`, `PlatformIcons`)
- An ink square tile with a white monochrome glyph (`PlatformGlyph`; brand colours are deliberately not used). Sizes: xs 20px/5px radius, sm 24px, md 32px, lg 44px.
- They carry `role="img"` and an `aria-label` with the platform name. A row of icons uses `PlatformIcons` (deduplicated, 4px gap).
- A new platform (e.g. Facebook) is added once to `PLATFORMS` and `PlatformGlyph` in `lib/publishing.tsx`.

### Cards (`.card`, `.card-head`, `.card-title`, `.card-link`, `.card-hover`)
- White surface, `line` border, 12px radius, `shadow-1`.
- The header row (`SectionHeading`) is 56px with the title on the left and a meta/action or `.card-link` (teal 12px) on the right.
- Rows inside cards use `.row-link`: a 2.5% ink hover tint and an inset focus ring.
- Interactive cards add `.card-hover`. Keyboard focus shows a teal border plus an 18% teal ring.

### Tables (`.table-head`, `.table-row`)
- Head: mono 10px uppercase in `label`, 12×20px padding. Rows: a `line` top border and a 2.5% ink hover.
- Numbers are right-aligned and tabular. Status columns use `StatusChip`, and platform columns use `PlatformIcons`.

### Charts (`components/charts.tsx`)
- Dependency-free SVG: `Sparkline` (teal line, ramp gradient fill, end dot), `BarTrend` (ramp bars, nice-ceiling axis), `RampLegend`, `Delta` (mono ▲/▼ in success/danger, `±0` in umber, "new" when there is no prior period).
- Axis and tick text: mono 11px in `label`. Every chart has an `aria-label` that reads out its data, and decorative layers are `aria-hidden`.
- Any chart that shows demo data renders `SimulatedBadge` ("Simulated · demo mode", dashed production-stage pill).

### Empty, loading and error states (`components/states.tsx`)
- **Skeletons** (`.skeleton`, 1.4s shimmer) match the final layout: `CardSkeleton`, `StatCardSkeleton`, `ListSkeleton`. Set `aria-busy` on the container. Never show a blank card or a spinner-only page.
- **EmptyState:** a 40px rounded-square icon on canvas, a 14px/500 title, a 13px umber hint, and an optional action. The hint names the next step ("Create a concept to start the pipeline"), not just "No data".
- **ErrorBanner:** a danger-tinted panel with `role="alert"`, a plain-language cause and a Retry secondary button.
- **Backend unreachable:** `pages/BackendErrorPage.tsx` replaces the app shell while the API is down, so an outage never looks like an empty workspace.

### Navigation (`layouts/AppShell.tsx`, `.nav-item`, `.nav-section`)
- **Desktop (≥ lg):** a sticky 256px (`w-64`) sidebar on canvas with a `line` right border. Groups follow the pipeline (Pipeline / Create / Review / Publish / Measure / Team; Business is collapsible), each with a mono `.nav-section` heading.
- **Nav item:** 38px tall, 10px radius, 14px/500 text at 72% ink. Active: `tint` background, `teal-press` 600 text and a 3×18px teal rail on the left. Count badges are an 18px teal pill with mono 10px text.
- **Mobile (< lg):** a top bar with an `icon-btn` menu (`aria-expanded`) opens the same nav as a drawer: `role="dialog"`, `aria-modal`, width `min(280px, 85vw)`, `shadow-pop` over the scrim, sliding in with `.drawer-in`. It closes on route change, on scrim click and on Escape.
- **Command palette:** ⌘K / Ctrl+K from anywhere.

### Forms (`.input`, `.label`, `.input-error`)
- Inputs are 40px with a 10px radius, a `line` border, `line-strong` on hover, and a teal border plus a 3px teal ring on focus.
- Placeholder text is `#78716C`. Labels use the mono `.label` recipe above the field. Errors use `.input-error` with a message below the field; link it with `aria-describedby` (not yet done everywhere).

### Segmented control (`.seg`)
Used for window pickers and view toggles. The selected segment is solid ink with white text, driven by `aria-pressed` or `aria-selected`.

### Toasts (`useToast`)
Every state-changing action confirms itself with a toast: bottom-right stack (max 320px wide), `shadow-pop`, `.toast-in` / `.toast-out`.

## 7. Motion

| Token | Curve | Use |
|---|---|---|
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | Enter and feedback (starts fast). The default |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | On-screen movement, the notification ping |
| `--ease-press` | `cubic-bezier(.3,0,.2,1)` | Button and icon press scale |

- **Durations:** 120–200ms for hover, colour and press; 240–400ms for entrances (`.fade-in` 280, `.rise-in` 380, `.modal-in` 260, `.page-enter` 340, `.toast-in` 240, `.drawer-in` 260). Never use `ease-in` for UI.
- **Entrances** drift up 8–10px and fade in. Lists can use `.stagger`, with 40ms steps capped at 8 children.
- Everything is wrapped in `prefers-reduced-motion: no-preference`. Under `reduce`, entrances, skeleton shimmer and the landing marquee are switched off.

## 8. Accessibility

- **Contrast** (measured, WCAG 2.x):
  - `ink`: 17.0:1 on canvas, 18.5:1 on surface.
  - `umber`: 5.4:1 on canvas, 5.8:1 on surface.
  - `label`: 7.0:1 on canvas, 7.6:1 on surface.
  - `teal`: 7.0:1 on canvas, 7.6:1 on surface.
  - White on teal: 7.6:1. White on danger: 6.6:1.
  - Every stage fg/bg pair is at least 5.7:1.
- **Watch-outs:**
  - `success` and `warning` text pass on canvas and surface (4.6–5.0:1) but fail on `cream` (4.2:1).
  - Placeholder `#78716C` is 4.4:1 on canvas and 4.0:1 on cream, so don't put inputs on cream.
  - Keep small coloured text on canvas or surface.
- **Focus:** a global `:focus-visible` 2px teal outline with a 2px offset. Inside lists, use an inset ring. Never remove an outline without a replacement.
- **Semantics:** platform icons and charts have accessible names; decorative icons are `aria-hidden`; errors use `role="alert"`; dialogs and the drawer use `role="dialog"` with `aria-modal`; icon-only buttons have an `aria-label`.
- **Targets:** interactive controls are at least 32px (most are 36–40px). Keep that floor on mobile.
- Status is never colour-only: a chip always carries text, and a dot sits next to a label or has a tooltip.

## 9. Do and don't

**Do**
- Use the recipes (`.card`, `.btn-*`, `StatusChip`, `PlatformIcon`, `EmptyState`) before writing new utilities.
- Keep one primary button per view, and make it the pipeline's next step.
- Show numbers in tabular figures, with `Delta` for change and "new" when there is no baseline.
- Label simulated data, every time.
- Add new tokens to `@theme` in `index.css` and document them here in the same PR.

**Don't**
- Don't add a second accent colour, gradients or glows inside the app. They are landing-only.
- Don't use the zinc/slate/gray Tailwind palettes or `#000`. Neutrals are ink at alpha, umber or label.
- Don't hand-colour a status, use brand-coloured platform logos, or invent a stage outside `stageOf()`.
- Don't use translate-on-hover cards, bouncy easings, `ease-in`, or motion that ignores reduced-motion.
- Don't show spinner-only pages or blank states, or let an outage render as an empty dashboard.
- Don't put body text on `cream`.

## 10. Known drift (clean up when touching the file)

- Some shadows and focus rings still use the old Tailwind teal-700 `rgba(15,118,110,…)` and red-600 `rgba(220,38,38,…)` in `index.css` (`.btn-primary`, `.btn-danger`, `.input:focus`, `.input-error`, `.brand-mark`, badge shadows). Retint them to `teal` `rgba(3,94,94,…)` and `danger` `rgba(180,35,24,…)`.
- Duplicate primitives: `components/primitives.tsx` has its own `EmptyState`, `Skeleton` and `Chip`/`statusTone`, and `components/ui.tsx` has a second `StatusDot`. The canonical versions are in `states.tsx` and `status.tsx`; migrate callers, then delete the duplicates.
- `charts.tsx` repeats the ramp hex values from `index.css`. Keep the two in sync, or read them from CSS variables.
- Facebook is not yet in `PLATFORMS` / `PlatformGlyph` (Phase 3).
