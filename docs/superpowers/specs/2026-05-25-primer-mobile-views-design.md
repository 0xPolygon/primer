# Primer Mobile Views — Design

**Date:** 2026-05-25
**Status:** Approved

## Goal

Make Primer usable on phones for the read-and-comment flow: open a document on your phone, view existing threads, reply, and start a new anchored thread by tapping an element in the artifact. Authoring (upload, versioning, admin) stays desktop-only.

Today the web app has essentially zero responsive treatment (one Tailwind breakpoint hit across `apps/web/src/`). The document route's 300px fixed sidebar + flex iframe collapses to ~75px of iframe on a 375px iPhone — unusable.

## Non-goals

- **Upload from mobile.** Out of scope.
- **Admin and dev-harness on mobile.** Out of scope.
- **"Add new version" modal on mobile.** Out of scope — it's authoring.
- **Text-range anchor selection on touch.** OS-mediated text selection inside an iframe on touch is a UX dead-end. Element-pick only on mobile.
- **A peek/preview of the element being picked.** No hover on touch; the finger covers the element. Tap-to-commit, with composer-Cancel as the recovery path.
- **Tuning for older iOS (< 17) or older Chrome (< 108).** Our `interactive-widget` viewport meta lands on those UAs as a no-op, and the `visualViewport` fallback (see Composer section) keeps them functional, but we don't test or tune for them. Polygon ships modern Apple-issued devices.
- **Android-specific tuning.** Spot-checked on Android Chrome (same standards as modern Safari) but not exhaustively tested.
- **Tablet-specific layout.** Single breakpoint at `md` (768px) — landscape tablets get desktop, portrait tablets get mobile, both are acceptable.
- **New dependencies.** No bottom-sheet library; small custom implementation. Consistent with the project's supply-chain stance.

## Breakpoint

One breakpoint: Tailwind `md` (768px).
- `< md` → mobile layout (this spec).
- `≥ md` → existing desktop layout, unchanged.

No `sm`-specific behavior, no progressive tiers. The desktop layout collapses cleanly down to ~640px (sidebar 300 + iframe ≥340), so the 768px cutover gives a comfort margin on portrait iPads.

Touch detection (for companion pick-mode behavior) uses `matchMedia('(hover: none) and (pointer: coarse)')`. Breakpoint and touch detection are independent — a touch-capable laptop in a wide viewport still gets the desktop layout.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AppShell (mobile padding tweaks)                           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Header  [Primer]  [theme] [user]   (px-3 on mobile)  │  │
│  ├──────────────────────────────────────────────────────┤  │
│  │                                                       │  │
│  │  Document route (< md)                                │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ Title · Version selector                        │  │  │
│  │  │ (no Add Version / Export / Delete on mobile)    │  │  │
│  │  ├────────────────────────────────────────────────┤  │  │
│  │  │                                                 │  │  │
│  │  │              Artifact iframe                    │  │  │
│  │  │           (full width, no constraint)           │  │  │
│  │  │                                                 │  │  │
│  │  │   ┌──────────────────────────────────────┐     │  │  │
│  │  │   │ Bottom Sheet — three snap points     │     │  │  │
│  │  │   │  • Handle (~48px)                     │     │  │  │
│  │  │   │  • Peek   (~38vh)                     │     │  │  │
│  │  │   │  • Expanded (~88vh, backdrop dim)     │     │  │  │
│  │  │   │  Contains: CommentSidebar's thread    │     │  │  │
│  │  │   │  list, NewThreadComposer, replies     │     │  │  │
│  │  │   └──────────────────────────────────────┘     │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

  Companion (apps/api/src/companion/v1.js)
    ├─ pick mode adds touch path (touchend mirrors click)
    ├─ in-iframe banner "Tap an element to add a comment · Cancel"
    └─ outline preview skipped when touch UA detected
```

## In scope (must work on phones)

- Home route (document list + dashboard).
- Document route — read, view threads, reply, start new anchored thread via element-pick.
- AppShell header.
- 404, version-not-found, error states.

## Out of scope (desktop-only with notice)

- Upload, Admin, Dev-harness, Add-Version modal.
- Below `md`, these routes render: *"This view isn't ready for mobile. Open Primer on a larger screen to use it."* with a link back to home. No half-built mobile UI.

## AppShell

- `header` padding: `px-3 sm:px-6` (was `px-6`).
- `main` padding: `p-3 sm:p-6` (was `p-6`).
- `UserMenu` dropdown — add `max-w-[calc(100vw-1rem)]` so it doesn't clip on narrow screens.

## Home route

- Hide `+ Add new version` and `+ Upload document` buttons below `md`.
- `max-w-3xl` container unchanged.
- `DocumentListRow` — hide timestamps below `md`, keep comment counts. The title side already uses `min-w-0 flex-1`, so it takes the reclaimed space.
- Empty-state Stephenson quote — unchanged.

## Document route — header

Compact on mobile:
- Title (`EditableField`, ellipsis-truncated, tap to edit — unchanged behavior).
- `VersionSelector` — already small enough.
- Hide on mobile: `+ Add Version`, Export-comments button, actions menu, delete confirmation. Pure conditional render with `hidden md:inline-flex` (or equivalent).
- Read-mostly amber banner stays, full width.

## Document route — bottom sheet

### Snap points

| Snap | Height | Visible content |
|---|---|---|
| **Handle** (default) | ~48px | Drag bar + `💬 N comments` label. Tap anywhere on this bar to expand to Peek. Overlays the bottom of the iframe. |
| **Peek** | ~38vh | Drag bar + `+ Add comment` button + scrollable thread list. Iframe visible above. No backdrop. |
| **Expanded** | ~88vh | Same content + composer when active. Backdrop dim (~`bg-black/30`) over the iframe. Artifact remains tappable (for element-pick). |

The `+ Add comment` button only appears at Peek/Expanded. To start a new thread from Handle, the user taps the handle to reach Peek, then taps `+ Add comment`.

### Drag mechanics

- Owned by a new `BottomSheet` component in `apps/web/src/components/`.
- Touch drag on the **handle bar only** (top ~48px). Touches inside the inner scroll area scroll the thread list; they do not move the sheet.
- Snap on release: choose the nearest snap point unless `|velocity| > threshold` (then snap in the drag direction).
- Transition: CSS `transform: translateY(...)` + `transition: transform 200ms ease`.
- No momentum/inertia beyond the snap. No "pull-down-from-top-of-content-to-dismiss" gesture.

### State

- `sheetSnap: 'handle' | 'peek' | 'expanded'` lives in `DocumentPage`.
- No persistence — defaults to `'handle'` on every page load.
- Programmatic transitions:
  - Anchor-click in iframe → `'peek'`, scroll list to the focused thread.
  - "+ Add comment" tap → `'handle'` while pick mode runs.
  - `element_picked` arrives → `'expanded'`, composer mounted.
  - Reply tap inside a thread → `'expanded'`.
  - Compose cancel → `'handle'`.

### Compose lock

While the composer is mounted (new thread or reply):
- Sheet is locked at `'expanded'`. Drag-down is disabled. Explicit Cancel still works.
- `<html>` gets `overflow: hidden` to prevent the iframe behind from scrolling under the keyboard.

### Sheet contents

- The existing `CommentSidebar` component renders inside the sheet. Its `collapsed`/`onCollapsedChange` props are no-ops on mobile (the sheet owns visibility).
- The `+ Add comment` trigger sits in the sheet's content area above the thread list, visible at Peek and Expanded snaps. On desktop this trigger doesn't exist — selection/click in the iframe drives composer-pending.
- Reply UX inside `ThreadCard` is unchanged. After tapping Reply, sheet auto-snaps to `'expanded'` and the sheet's internal scroll adjusts so the composer is in view.

### Anchor ↔ thread linking

Unchanged semantically; only the destination changes:
- Tap a 💬 badge / anchored text in the iframe → sheet snaps to `'peek'`, scrolls to that thread, applies focused-state styling (existing).
- Tap a thread in the sheet → existing `onHighlight` flashes the anchor in the iframe (existing).

### Hidden on mobile

- Floating "Add comment in sidebar →" pill (`document.tsx:506-521`). The bottom-sheet flow replaces it.

## Element-pick on touch

### Companion changes (`apps/api/src/companion/v1.js`)

Pick mode currently uses `mousemove` for outline preview and `click` to commit. `click` works on touch via tap synthesis, but with quirks; outline preview is meaningless on touch.

When pick mode enters AND the UA matches `(hover: none) and (pointer: coarse)`:
- Skip the outline preview entirely. Do not attach `mousemove`. Do not create the `__primer_pick_outline__` element.
- Set `body.style.cursor = 'pointer'` instead of `'crosshair'` (invisible on touch anyway, but `pointer` is what iOS Safari uses to reliably synthesize `click` on non-button elements).
- Attach a `touchend` capture-phase listener that mirrors `onPickClick`'s commit path. Guards against double-fire by clearing `pickActive` on the first to fire.
- Render an in-iframe banner pinned to the top of the iframe viewport: *"Tap an element to add a comment · Cancel"*. The Cancel link invokes the companion's existing `exitPickMode()` directly (companion → parent then emits `pick_mode_exited` per the existing protocol). The banner uses the existing overlay (`__primer_overlay__`).

The desktop pick path is unchanged.

### Parent changes

- The sheet handle label switches from `💬 N comments` to `Picking element…` while `pickActive`.
- Tapping the sheet handle while `pickActive` cancels pick (parent sends `exit_pick_mode`).
- ESC keydown still cancels pick on desktop (unchanged).

### Recovery for mis-picks

Composer's Cancel returns the sheet to `'handle'`. User retries by tapping "+ Add comment" again. No automatic undo.

## Composer and virtual keyboard

### Viewport meta

`apps/web/index.html` viewport meta is set to:
```
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
```

`interactive-widget=resizes-content` causes modern Safari/Chrome to shrink the visual viewport when the keyboard appears, so the sheet (anchored to `bottom: 0`) rides above the keyboard automatically.

### Fallback (older Safari)

For UAs that ignore `interactive-widget`:
- Subscribe to `window.visualViewport`'s `resize` and `scroll` events.
- Compute `keyboardInset = window.innerHeight - (visualViewport.height + visualViewport.offsetTop)`.
- Apply as CSS variable `--keyboard-inset` on `<html>`. Sheet bottom: `bottom: var(--keyboard-inset, 0)`.

### Auto-focus

Composer textarea uses `autoFocus` only when mounted from a user gesture (Reply tap, element-pick completion). iOS Safari refuses to open the keyboard for non-gesture-driven focus.

### Mentions dropdown

`MentionTextarea`'s suggestion popup currently anchors below the textarea. On mobile that lands under the keyboard. Change:
- Measure available space above and below the textarea relative to the visual viewport.
- Anchor the dropdown to whichever side has more room.
- Cap dropdown height at `min(40vh, available-space - 8px)`.

This change applies regardless of viewport size — the "anchor above when no room below" behavior is a general improvement.

### Post-submit

- Sheet stays at `'expanded'`.
- Sheet's internal scroll adjusts to keep the newly-posted comment in view.
- Active element blurs to dismiss the keyboard.

## Iframe sizing

No special handling. The iframe takes 100% of the available width below the header. Whatever the artifact author shipped is what the user sees. Pinch-zoom + pan handles desktop-fixed-width artifacts.

The artifact controls its own viewport meta; the parent does not inject anything into the iframe.

## Verification

### CI (Vitest)

- Bottom-sheet snap-resolution: given a current y, velocity, and snap-points list, returns the correct target snap.
- Companion touch path: with mocked touch events + mocked `matchMedia`, `touchend` commits a pick; mouse path remains unaffected when not on touch UA; double-fire is prevented when both `touchend` and synthesized `click` would fire.
- Existing suite stays green.

### Local (DevTools)

- Chrome DevTools iPhone 14 / Pixel 7 emulation: visual smoke + interaction (drag, tap-to-pick, compose, submit).
- Firefox responsive design mode for cross-engine layout sanity.

### Real device (gate before merging to master)

`master` auto-deploys to Railway, so a half-working mobile experience would reach teammates. Before greenlighting a push:

- iOS Safari (current iPhone): full read+reply+pick+compose flow.
- Real-device confirmation of the keyboard-inset behavior (the `interactive-widget` path; fallback path if anyone is on older Safari).
- Android Chrome: spot check.

User (Taylan) drives real-device verification. The implementation lands behind no flag — it's the only mobile experience — so verification is a gate, not a flip.

## Files touched (approximate)

New:
- `apps/web/src/components/BottomSheet.tsx` (+ test).
- `apps/web/src/lib/useTouchDevice.ts` (or inline `matchMedia` use).
- `apps/web/src/lib/useKeyboardInset.ts` (fallback for older Safari).

Modified:
- `apps/web/index.html` — viewport meta.
- `apps/web/src/AppShell.tsx` — padding.
- `apps/web/src/routes/home.tsx` + `apps/web/src/components/DocumentListRow.tsx` — hide buttons and timestamps below `md`.
- `apps/web/src/routes/document.tsx` — header conditional rendering; bottom-sheet integration; mobile-vs-desktop layout fork.
- `apps/web/src/routes/upload.tsx`, `routes/admin.tsx`, `routes/devHarness.tsx` — mobile "use a larger screen" notice.
- `apps/web/src/components/CommentSidebar.tsx` — small additions for "+ Add comment" trigger when running inside the sheet (or that trigger lives in the sheet header itself; implementation choice).
- `apps/web/src/components/MentionTextarea.tsx` — flip dropdown direction based on available space.
- `apps/api/src/companion/v1.js` — touch path in pick mode, in-iframe banner.

## Open questions for implementation

None at design time. Specific Tailwind class choices, pixel measurements (handle height, snap velocities, transition timing), and the exact mounting strategy for the bottom sheet (portal vs. inline) are implementation details for the plan.
