# Mobile Document View — Compact Header + Fit-to-Width Artifacts

**Date:** 2026-07-14
**Issue:** #71 (redo of #70)
**Scope:** `apps/web` document route/header, companion script, `@primer/shared` protocol

## Background

PR #70 attempted to fix the mobile document view and shipped, but produced no
visible change:

- The header fix only shrank the title font by 2px, and its `line-clamp-2` on
  the description is dead CSS — the same class string carries `inline-block`,
  which wins the `display` cascade over `-webkit-box` (equal specificity,
  later in the compiled stylesheet), and `-webkit-line-clamp` requires
  `-webkit-box`. The header's actual layout problem — a single flex row where
  the `shrink-0` action cluster squeezes the title/description column on
  ~390px screens, leaving dead space under the buttons — was never addressed.
- The iframe fix injected `<meta name="viewport">` into artifacts, but
  viewport metas are ignored inside iframes; an iframe's layout viewport is
  its element's CSS size. Horizontal scrolling is caused by the artifact
  content's own fixed-width CSS overflowing a device-width iframe. The
  injection stays (it helps published/top-level artifact pages) but cannot fix
  the in-app view.

## Design

### 1. Compact mobile header (below `md`; desktop visually unchanged)

**Structure.** Extract the version selector + ⋯ actions menu into a
`HeaderActions` component rendered in two places:

- Mobile (`md:hidden`): inline on the breadcrumb row, right-aligned.
- Desktop (`hidden md:flex`): the current position in the action cluster.

Each instance owns its menu open/closed state; only one instance is visible
per breakpoint, so popovers anchor naturally. Mobile header rows, all
full-width: breadcrumb + actions → title → description.

**Actions on mobile.**

- The Share button moves into the ⋯ menu as a "Share…" entry (uploader-only,
  opens the existing `ShareModal`), added via a new flag on `buildMenuItems()`.
- The folder-move control (`DocDetailFolderControl`) is hidden on mobile with
  no menu replacement. Accepted feature cut: folder moves remain
  desktop-only.
- "+ Add Comment" and uploader info already hide on mobile; unchanged.

**Clamps.**

- Title: `line-clamp-2` below `md`; desktop unchanged.
- Description: clamp to 2 lines below `md` with a *working* clamp — the base
  (mobile) layer must not carry a competing `display` utility; the `md:`
  variants restore today's desktop styling (`md:inline-block`,
  `md:max-w-[60ch]`, `md:line-clamp-none`, …). Tailwind sorts `md:` variants
  after base utilities, so the cascade is deterministic.

### 2. Fit-to-width artifacts (mobile only)

**Companion (runs inside every artifact iframe, old and new — loaded fresh
from `/companion/v1.js`).** Measure
`contentWidth = max(documentElement.scrollWidth, body.scrollWidth)` against
`documentElement.clientWidth` on load and on content changes (debounced
ResizeObserver + window resize). When content overflows (small tolerance,
~2%), post a new `content_metrics { contentWidth }` message over the existing
typed MessagePort protocol.

**Protocol.** Add `content_metrics` to the inbound message schema in
`@primer/shared`. Old cached companions (≤1h, `max-age=3600`) never send it —
graceful no-op.

**Parent (`ArtifactIframe`).** On mobile only:

- `scale = clamp(containerWidth / contentWidth, 0.5, 1)`.
- If `scale < 1`: size the iframe at `containerSize / scale` and apply
  `transform: scale(scale)` with `transform-origin: top left`, so content
  reflows at its natural width and is shrunk to fit.
- Content that fits renders 1:1. At the 0.5× floor, the wrapper permits
  residual horizontal scroll (degenerate ultra-wide content stays legible).
- Hysteresis to prevent reflow→re-measure oscillation: only grow the layout
  width on subsequent reports; reset to 1:1 when reported content fits the
  container width.
- Replace the iframe's hardcoded `calc(100vh - 120px)` height with
  wrapper-driven sizing (the wrapper is already `flex-1 overflow-hidden`), so
  the scale math has a real box to fill.

**Why the comments pipeline is safe.** Highlights/anchor markers are drawn
inside the iframe by the companion and scale uniformly with the content.
Browsers map touch/click coordinates through CSS transforms, so pick mode and
anchor taps keep working. The selection pill's parent-side coordinate math is
desktop-only (`!isMobile`). The mobile bottom sheet uses anchor `y` values
for ordering only, which scaling preserves.

## Acceptance criteria

From issue #71:

1. Mobile header: title full-width (no side-by-side squeeze), long titles
   clamped; description clamps to 2 lines with a working clamp; actions
   reachable in compact form; no large dead space; artifact area gains the
   space; `md`+ visually unchanged.
2. Artifacts: content wider than the iframe scales to fit (no horizontal
   scroll to read) down to at most 0.5×; content that fits renders 1:1;
   desktop behavior unchanged; comment anchoring/selection overlays still
   align where active.

## Non-goals

- Rewriting/normalizing artifact CSS at upload time.
- Removing the #70 viewport-meta injection (kept: harmless in iframes,
  useful for top-level/published pages).
- Folder-move on mobile.
- Scaling on desktop viewports.

## Testing

- Unit: scale/hysteresis math (pure function); `content_metrics` schema
  parsing; companion measurement guard; `buildMenuItems()` with the new flag.
- Existing API (636) and web (195) suites stay green; both apps typecheck.
- Visual verification on a real phone is handed to the reviewer after deploy
  (no emulated screenshots).
