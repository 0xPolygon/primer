# Primer Mobile Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Primer usable on phones for the read-and-comment flow — view documents, view existing threads, reply, and create new anchored threads via element-pick.

**Architecture:** Single Tailwind breakpoint at `md` (768px). Below it the document route swaps its desktop sidebar for a draggable bottom sheet (three snap points: handle / peek / expanded); the companion script adds a touch path to pick mode; other authoring routes show a "use a larger screen" notice. Above `md` the existing desktop layout is untouched.

**Tech Stack:** React 19 + Vite, Tailwind 4 (CSS-imported, default breakpoints), TypeScript, Vitest (node environment, pure-logic tests only). Companion script is plain ES2020 JS that runs inside the artifact iframe with no bundler.

**Spec:** `docs/superpowers/specs/2026-05-25-primer-mobile-views-design.md`

**Important constraints from project memory:**
- Use `pnpm`, not `npm`.
- Never `git push` without explicit instruction in the turn — `master` auto-deploys to Railway. Every task ends with a commit; pushing is the user's call after real-device verification.
- Don't skip git hooks (`--no-verify`) or signing.

---

## File map

**New:**
- `apps/web/src/lib/useMediaQuery.ts` — small hook for runtime viewport check.
- `apps/web/src/lib/useKeyboardInset.ts` — visualViewport-based keyboard inset.
- `apps/web/src/components/DesktopOnly.tsx` — wraps an out-of-scope route with a mobile notice.
- `apps/web/src/components/BottomSheet.snap.ts` — pure snap-resolver logic.
- `apps/web/src/components/BottomSheet.snap.test.ts` — tests for the resolver.
- `apps/web/src/components/BottomSheet.tsx` — sheet component + context.

**Modified:**
- `apps/web/index.html` — viewport meta.
- `apps/web/src/AppShell.tsx` — mobile padding.
- `apps/web/src/routes/home.tsx` — hide authoring buttons.
- `apps/web/src/components/DocumentListRow.tsx` — hide timestamps on mobile.
- `apps/web/src/routes/upload.tsx`, `apps/web/src/routes/admin.tsx`, `apps/web/src/routes/devHarness.tsx` — wrap in `DesktopOnly`.
- `apps/web/src/components/MentionTextarea.tsx` — flip dropdown above-or-below.
- `apps/web/src/routes/document.tsx` — mobile fork + sheet integration.
- `apps/web/src/components/CommentSidebar.tsx` — optional "+ Add comment" trigger.
- `apps/web/src/components/ThreadCard.tsx` — snap sheet to expanded on reply.
- `apps/api/src/companion/v1.js` — touch path in pick mode + in-iframe banner.

---

### Task 1: Viewport meta + AppShell padding

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/src/AppShell.tsx`

- [ ] **Step 1: Update viewport meta**

In `apps/web/index.html` line 5, replace:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

with:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content" />
```

`interactive-widget=resizes-content` makes modern Safari/Chrome shrink the layout viewport when the on-screen keyboard appears, so any `position: fixed; bottom: 0` element (our sheet) stays above the keyboard without per-element JS.

- [ ] **Step 2: Loosen AppShell padding on mobile**

In `apps/web/src/AppShell.tsx`, replace the header and main lines:

```tsx
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3 flex items-center justify-between">
```

with:

```tsx
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-3 sm:px-6 py-3 flex items-center justify-between">
```

and:

```tsx
      <main className="flex-1 p-6">
```

with:

```tsx
      <main className="flex-1 p-3 sm:p-6">
```

- [ ] **Step 3: Typecheck and test**

Run from repo root:

```
pnpm typecheck && pnpm test
```

Expected: PASS (no existing tests touch these files; no new types added).

- [ ] **Step 4: Commit**

```
git add apps/web/index.html apps/web/src/AppShell.tsx
git commit -m "feat(web): mobile viewport meta + tighter AppShell padding"
```

---

### Task 2: DesktopOnly wrapper for out-of-scope routes

**Files:**
- Create: `apps/web/src/components/DesktopOnly.tsx`
- Modify: `apps/web/src/routes/upload.tsx`
- Modify: `apps/web/src/routes/admin.tsx`
- Modify: `apps/web/src/routes/devHarness.tsx`

- [ ] **Step 1: Create DesktopOnly component**

Write `apps/web/src/components/DesktopOnly.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  children: ReactNode;
}

export function DesktopOnly({ children }: Props) {
  return (
    <>
      <div className="md:hidden mx-auto max-w-md py-12 text-center">
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          This view isn't ready for mobile. Open Primer on a larger screen to use it.
        </p>
        <Link
          to="/"
          className="mt-4 inline-block rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-300"
        >
          Back to home
        </Link>
      </div>
      <div className="hidden md:block">{children}</div>
    </>
  );
}
```

CSS-only show/hide via Tailwind's `md:` breakpoint. The desktop content still mounts (no JS gating) so the React tree is the same; only display differs. That's fine — these routes are tiny and harmless when hidden.

- [ ] **Step 2: Wrap upload route**

In `apps/web/src/routes/upload.tsx`, find the `return (` block of `UploadPage` and wrap its entire JSX in `<DesktopOnly>...</DesktopOnly>`. Add the import at the top:

```tsx
import { DesktopOnly } from '../components/DesktopOnly.tsx';
```

Example (pseudocode showing the structure):

```tsx
export function UploadPage() {
  // ... existing hooks/state/handlers unchanged ...
  return (
    <DesktopOnly>
      {/* ... existing JSX ... */}
    </DesktopOnly>
  );
}
```

- [ ] **Step 3: Wrap admin route**

Same change in `apps/web/src/routes/admin.tsx` — add the `DesktopOnly` import and wrap the page's outer JSX.

- [ ] **Step 4: Wrap dev harness route**

Same change in `apps/web/src/routes/devHarness.tsx`.

- [ ] **Step 5: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add apps/web/src/components/DesktopOnly.tsx apps/web/src/routes/upload.tsx apps/web/src/routes/admin.tsx apps/web/src/routes/devHarness.tsx
git commit -m "feat(web): mobile notice on upload/admin/dev-harness routes"
```

---

### Task 3: Home route mobile tweaks

**Files:**
- Modify: `apps/web/src/routes/home.tsx`
- Modify: `apps/web/src/components/DocumentListRow.tsx`

- [ ] **Step 1: Hide authoring buttons on home below `md`**

In `apps/web/src/routes/home.tsx`, find the header `<div className="flex items-center gap-2">` that wraps the two action buttons (`+ Add new version` and `+ Upload document`). Change its className to:

```tsx
        <div className="hidden md:flex items-center gap-2">
```

The `AddVersionModal` controlled by `showAddVersion` cannot be opened from mobile after this change (its only trigger is hidden), so no further wiring needed.

- [ ] **Step 2: Hide timestamps in MyDocumentRow and ActivityRow on mobile**

In `apps/web/src/components/DocumentListRow.tsx`, find the timestamp `<span>` inside `MyDocumentRow` (around line 45):

```tsx
        <span className="w-20 text-right text-xs text-neutral-500">
          {relativeTime(doc.lastActivityAt)}
        </span>
```

Change to:

```tsx
        <span className="hidden sm:inline w-20 text-right text-xs text-neutral-500">
          {relativeTime(doc.lastActivityAt)}
        </span>
```

Make the same change inside `ActivityRow` (around line 80):

```tsx
        <span className="hidden sm:inline w-20 text-right text-xs text-neutral-500">
          {relativeTime(entry.signalAt)}
        </span>
```

Leave `DeletedDocumentRow` alone — the deleted timestamp + days-remaining are critical info.

- [ ] **Step 3: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add apps/web/src/routes/home.tsx apps/web/src/components/DocumentListRow.tsx
git commit -m "feat(web): hide authoring buttons + activity timestamps on mobile home"
```

---

### Task 4: MentionTextarea direction-aware dropdown

**Files:**
- Modify: `apps/web/src/components/MentionTextarea.tsx`

This change applies universally (not gated by mobile breakpoint) — anchoring the dropdown to whichever side has more room is a strict improvement.

- [ ] **Step 1: Add useRef for direction state**

In `apps/web/src/components/MentionTextarea.tsx`, find the existing hook setup (around line 36–45). Add a new state:

```tsx
  const [dropdownPlacement, setDropdownPlacement] = useState<'below' | 'above'>('below');
```

Place it next to the existing `useState` calls (immediately after the `highlightIdx` line).

- [ ] **Step 2: Compute placement when trigger changes**

Add this effect after the existing `useEffect` that calls `onMentionsChange`:

```tsx
  useEffect(() => {
    if (!trigger) return;
    const ta = taRef.current;
    if (!ta) return;
    // Use visualViewport when available so the keyboard's intruded height is
    // factored in; fall back to innerHeight on older UAs.
    const viewportH =
      typeof window !== 'undefined' && window.visualViewport
        ? window.visualViewport.height + window.visualViewport.offsetTop
        : window.innerHeight;
    const r = ta.getBoundingClientRect();
    const spaceBelow = viewportH - r.bottom;
    const spaceAbove = r.top;
    // Dropdown is max-h-44 ≈ 11rem ≈ 176px. Need ~180px to comfortably fit.
    setDropdownPlacement(spaceBelow >= 180 || spaceBelow >= spaceAbove ? 'below' : 'above');
  }, [trigger]);
```

- [ ] **Step 3: Apply placement to the dropdown classes**

Find the dropdown `<ul role="listbox">` at the bottom of the component (around line 134) and change its className:

```tsx
        <ul
          role="listbox"
          className={`absolute left-0 right-0 z-20 max-h-44 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-md ${
            dropdownPlacement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
```

(Replaces the existing `mt-1` positioning so the dropdown sits below or above the textarea conditionally.)

- [ ] **Step 4: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS. (No existing tests touch dropdown positioning.)

- [ ] **Step 5: Commit**

```
git add apps/web/src/components/MentionTextarea.tsx
git commit -m "feat(web): mention dropdown picks the side with more room"
```

---

### Task 5: BottomSheet snap-resolver (pure logic + tests)

**Files:**
- Create: `apps/web/src/components/BottomSheet.snap.ts`
- Test: `apps/web/src/components/BottomSheet.snap.test.ts`

This is the math behind "given a release y/velocity, which snap should we land on?" Extracted so it's testable without React or DOM.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/BottomSheet.snap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSnap, type SnapDef } from './BottomSheet.snap.ts';

const SNAPS: SnapDef[] = [
  { name: 'handle', height: 48 },
  { name: 'peek', height: 300 },
  { name: 'expanded', height: 700 },
];

describe('resolveSnap', () => {
  it('snaps to nearest when velocity is below threshold', () => {
    expect(resolveSnap({ currentHeight: 60, velocity: 0, snaps: SNAPS })).toBe('handle');
    expect(resolveSnap({ currentHeight: 180, velocity: 0, snaps: SNAPS })).toBe('peek');
    expect(resolveSnap({ currentHeight: 600, velocity: 0, snaps: SNAPS })).toBe('expanded');
  });

  it('snaps to next-smaller when velocity is strongly downward', () => {
    // velocity > threshold = sheet shrinking
    expect(resolveSnap({ currentHeight: 500, velocity: 2, snaps: SNAPS })).toBe('peek');
    expect(resolveSnap({ currentHeight: 200, velocity: 2, snaps: SNAPS })).toBe('handle');
  });

  it('snaps to next-larger when velocity is strongly upward', () => {
    // velocity < -threshold = sheet growing
    expect(resolveSnap({ currentHeight: 200, velocity: -2, snaps: SNAPS })).toBe('peek');
    expect(resolveSnap({ currentHeight: 400, velocity: -2, snaps: SNAPS })).toBe('expanded');
  });

  it('clamps to the smallest snap when shrinking past handle', () => {
    expect(resolveSnap({ currentHeight: 40, velocity: 2, snaps: SNAPS })).toBe('handle');
  });

  it('clamps to the largest snap when growing past expanded', () => {
    expect(resolveSnap({ currentHeight: 800, velocity: -2, snaps: SNAPS })).toBe('expanded');
  });

  it('respects a custom velocityThreshold', () => {
    // velocity 0.3 < default 0.5, but > custom 0.1 — treat as shrinking.
    expect(
      resolveSnap({ currentHeight: 500, velocity: 0.3, snaps: SNAPS, velocityThreshold: 0.1 }),
    ).toBe('peek');
  });

  it('handles snaps passed in arbitrary order', () => {
    const shuffled: SnapDef[] = [
      { name: 'expanded', height: 700 },
      { name: 'handle', height: 48 },
      { name: 'peek', height: 300 },
    ];
    expect(resolveSnap({ currentHeight: 60, velocity: 0, snaps: shuffled })).toBe('handle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
cd apps/web && pnpm test BottomSheet.snap
```

Expected: FAIL with "Cannot find module './BottomSheet.snap.ts'" or similar.

- [ ] **Step 3: Implement the resolver**

Create `apps/web/src/components/BottomSheet.snap.ts`:

```ts
export type SnapPoint = 'handle' | 'peek' | 'expanded';

export interface SnapDef {
  name: SnapPoint;
  /** Sheet height (px) at this snap. Heights must be unique. */
  height: number;
}

export interface ResolveInput {
  /** Sheet height (px) at the moment of release. */
  currentHeight: number;
  /** px/ms — positive = sheet shrinking (drag-down), negative = growing. */
  velocity: number;
  /** All available snaps. Order doesn't matter; we sort internally. */
  snaps: SnapDef[];
  /** |velocity| above this picks direction-based snap; below = nearest. */
  velocityThreshold?: number;
}

export function resolveSnap({
  currentHeight,
  velocity,
  snaps,
  velocityThreshold = 0.5,
}: ResolveInput): SnapPoint {
  const ascending = [...snaps].sort((a, b) => a.height - b.height);

  if (velocity > velocityThreshold) {
    // Sheet shrinking — pick the next snap strictly below current height.
    const below = [...ascending].reverse().find((s) => s.height < currentHeight);
    return (below ?? ascending[0]).name;
  }
  if (velocity < -velocityThreshold) {
    // Sheet growing — pick the next snap strictly above current height.
    const above = ascending.find((s) => s.height > currentHeight);
    return (above ?? ascending[ascending.length - 1]).name;
  }

  let nearest = ascending[0];
  let bestDist = Math.abs(nearest.height - currentHeight);
  for (const s of ascending) {
    const d = Math.abs(s.height - currentHeight);
    if (d < bestDist) {
      bestDist = d;
      nearest = s;
    }
  }
  return nearest.name;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd apps/web && pnpm test BottomSheet.snap
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```
git add apps/web/src/components/BottomSheet.snap.ts apps/web/src/components/BottomSheet.snap.test.ts
git commit -m "feat(web): pure snap-resolver for bottom-sheet drag release"
```

---

### Task 6: useMediaQuery + useKeyboardInset hooks

**Files:**
- Create: `apps/web/src/lib/useMediaQuery.ts`
- Create: `apps/web/src/lib/useKeyboardInset.ts`

Two small hooks. No tests — pure DOM wrapping; tests would just mock matchMedia / visualViewport and assert plumbing. Verified through the document route in Task 8.

- [ ] **Step 1: Create useMediaQuery**

Write `apps/web/src/lib/useMediaQuery.ts`:

```ts
import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Returns `false` during SSR / pre-mount
 * (Primer is a Vite SPA, so this only matters for the very first paint).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    // Re-read in case the value changed between render and subscribe.
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
```

- [ ] **Step 2: Create useKeyboardInset**

Write `apps/web/src/lib/useKeyboardInset.ts`:

```ts
import { useEffect, useState } from 'react';

/**
 * Returns the number of pixels at the bottom of the layout viewport currently
 * obscured by the on-screen keyboard (or other UA chrome). Zero when no
 * keyboard is up, or when the UA honors `interactive-widget=resizes-content`
 * (in which case `window.innerHeight` already equals `visualViewport.height`).
 *
 * Defensive: if `visualViewport` is unavailable (very old UAs), returns 0
 * permanently — the sheet will be hidden behind the keyboard on those, which
 * is the degraded behavior we accept per the design spec.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;

    const compute = () => {
      const obscured = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(obscured)));
    };
    compute();
    vv.addEventListener('resize', compute);
    vv.addEventListener('scroll', compute);
    return () => {
      vv.removeEventListener('resize', compute);
      vv.removeEventListener('scroll', compute);
    };
  }, []);

  return inset;
}
```

- [ ] **Step 3: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```
git add apps/web/src/lib/useMediaQuery.ts apps/web/src/lib/useKeyboardInset.ts
git commit -m "feat(web): useMediaQuery + useKeyboardInset hooks"
```

---

### Task 7: BottomSheet component + context

**Files:**
- Create: `apps/web/src/components/BottomSheet.tsx`

The component renders three things: an optional backdrop, the sheet itself (handle bar + scrollable content), and exposes a context so descendants can imperatively snap the sheet.

- [ ] **Step 1: Implement the component**

Write `apps/web/src/components/BottomSheet.tsx`:

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { resolveSnap, type SnapDef, type SnapPoint } from './BottomSheet.snap.ts';
import { useKeyboardInset } from '../lib/useKeyboardInset.ts';

export type { SnapPoint } from './BottomSheet.snap.ts';

interface BottomSheetCtx {
  snapTo: (s: SnapPoint) => void;
}
const Ctx = createContext<BottomSheetCtx | null>(null);

/** Imperative handle for descendants (e.g. ThreadCard) to drive sheet snap. */
export function useBottomSheet(): BottomSheetCtx | null {
  return useContext(Ctx);
}

interface Props {
  snap: SnapPoint;
  onSnapChange: (next: SnapPoint) => void;
  /** Label rendered on the handle bar (e.g. "💬 3 comments"). */
  handleLabel: ReactNode;
  /** Disable drag and tap-to-toggle. Used while composing. */
  dragLocked?: boolean;
  /** Dim backdrop shown at the `expanded` snap. Tapping dismisses to handle. */
  showBackdrop?: boolean;
  children: ReactNode;
}

const HANDLE_PX = 48;

export function BottomSheet({
  snap,
  onSnapChange,
  handleLabel,
  dragLocked = false,
  showBackdrop = true,
  children,
}: Props) {
  const keyboardInset = useKeyboardInset();
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);

  const snaps: SnapDef[] = [
    { name: 'handle', height: HANDLE_PX },
    { name: 'peek', height: Math.round(vh * 0.38) },
    { name: 'expanded', height: Math.round(vh * 0.88) },
  ];
  const snapHeight = (name: SnapPoint): number =>
    snaps.find((s) => s.name === name)?.height ?? HANDLE_PX;

  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const startRef = useRef<{ y: number; height: number; t: number } | null>(null);
  const lastRef = useRef<{ y: number; t: number } | null>(null);

  const renderedHeight = dragHeight ?? snapHeight(snap);
  const dimmerVisible = showBackdrop && snap === 'expanded' && dragHeight === null;

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (dragLocked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const now = performance.now();
    startRef.current = { y: e.clientY, height: snapHeight(snap), t: now };
    lastRef.current = { y: e.clientY, t: now };
    setDragHeight(snapHeight(snap));
  }

  function onPointerMove(e: ReactPointerEvent<HTMLButtonElement>) {
    if (!startRef.current) return;
    const dy = e.clientY - startRef.current.y;
    // Drag-down = height shrinks; drag-up = height grows.
    const next = Math.max(HANDLE_PX, Math.min(vh, startRef.current.height - dy));
    setDragHeight(next);
    lastRef.current = { y: e.clientY, t: performance.now() };
  }

  function onPointerUp(_e: ReactPointerEvent<HTMLButtonElement>) {
    const start = startRef.current;
    const last = lastRef.current;
    if (!start) return;
    let velocity = 0;
    if (last && last.t > start.t) {
      // px/ms; positive = pointer moved down = sheet shrinking.
      velocity = (last.y - start.y) / (last.t - start.t);
    }
    const next = resolveSnap({
      currentHeight: dragHeight ?? snapHeight(snap),
      velocity,
      snaps,
    });
    startRef.current = null;
    lastRef.current = null;
    setDragHeight(null);
    if (next !== snap) onSnapChange(next);
  }

  function onHandleClick() {
    if (dragLocked) return;
    if (dragHeight !== null) return; // Click fired alongside drag — ignore.
    if (snap === 'handle') onSnapChange('peek');
    else onSnapChange('handle');
  }

  // Lock html scroll while the sheet is at expanded OR composing.
  useEffect(() => {
    if (snap !== 'expanded' && !dragLocked) return;
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
    };
  }, [snap, dragLocked]);

  return (
    <Ctx.Provider value={{ snapTo: onSnapChange }}>
      {dimmerVisible && (
        <div
          className="fixed inset-0 z-30 bg-black/30"
          onClick={() => onSnapChange('handle')}
          aria-hidden
        />
      )}
      <div
        className="fixed left-0 right-0 z-40 flex flex-col overflow-hidden rounded-t-xl border-t border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
        style={{
          bottom: `${keyboardInset}px`,
          height: `${renderedHeight}px`,
          transition: dragHeight === null ? 'height 200ms ease' : 'none',
        }}
        role="dialog"
        aria-label="Comments"
      >
        <button
          type="button"
          onClick={onHandleClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ touchAction: 'none', height: `${HANDLE_PX}px` }}
          className="flex shrink-0 items-center justify-center gap-3 border-b border-neutral-200 px-3 text-xs text-neutral-700 dark:border-neutral-800 dark:text-neutral-300"
          aria-label="Drag to resize comments panel"
        >
          <span
            aria-hidden
            className="block h-1 w-10 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-700"
          />
          <span className="truncate">{handleLabel}</span>
        </button>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </Ctx.Provider>
  );
}
```

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/src/components/BottomSheet.tsx
git commit -m "feat(web): bottom-sheet component with drag-snap + context"
```

---

### Task 8: CommentSidebar — optional "+ Add comment" trigger

**Files:**
- Modify: `apps/web/src/components/CommentSidebar.tsx`

When the sheet hosts the sidebar on mobile, the user needs a button to start a new anchored thread. Add an optional prop the document route only sets in mobile mode.

- [ ] **Step 1: Add prop and render the button**

In `apps/web/src/components/CommentSidebar.tsx`, extend `Props`:

```tsx
interface Props {
  versionId: string;
  currentUserId: string;
  pending: PendingAnchor | null;
  onCancelPending: () => void;
  onSubmitPending: (body: string, mentions: string[]) => Promise<void>;
  onHighlight: (anchorId: string) => void;
  positionsByAnchorId?: Map<string, { y: number; drifted: boolean }>;
  collapsed?: boolean;
  onCollapsedChange?: (next: boolean) => void;
  focusedThreadId?: string | null;
  /** Mobile-only: when set, render a "+ Add comment" trigger above the
   *  thread list. The handler is expected to enter pick mode AND snap the
   *  sheet to handle so the iframe is fully tappable. */
  onAddCommentClick?: () => void;
  /** True while the parent is in pick mode — used to dim/disable the button. */
  addCommentActive?: boolean;
}
```

Destructure the new props in the function signature (immediately after `focusedThreadId = null,`):

```tsx
  onAddCommentClick,
  addCommentActive = false,
```

- [ ] **Step 2: Render the trigger**

Inside the expanded sidebar's `<aside>` block (the second return, around line 134), insert this just after the `<header>` and before the `{pending && ...}` block:

```tsx
      {onAddCommentClick && !pending && (
        <div className="border-b border-neutral-200 dark:border-neutral-800 px-3 py-2">
          <button
            type="button"
            onClick={onAddCommentClick}
            className={`w-full rounded px-3 py-2 text-sm ${
              addCommentActive
                ? 'bg-red-600 text-white'
                : 'border border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
            }`}
          >
            {addCommentActive ? 'Cancel' : '+ Add comment'}
          </button>
        </div>
      )}
```

- [ ] **Step 3: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS. (No existing tests on CommentSidebar.)

- [ ] **Step 4: Commit**

```
git add apps/web/src/components/CommentSidebar.tsx
git commit -m "feat(web): optional + Add comment trigger in CommentSidebar"
```

---

### Task 9: ThreadCard — snap sheet to expanded on reply

**Files:**
- Modify: `apps/web/src/components/ThreadCard.tsx`

When the user taps Reply on mobile, the sheet should auto-expand so the composer is visible above the keyboard.

- [ ] **Step 1: Wire useBottomSheet into startReplying**

In `apps/web/src/components/ThreadCard.tsx`:

1. Add this import near the top (next to the other component imports):

```tsx
import { useBottomSheet } from './BottomSheet.tsx';
```

2. Find the `startReplying` function (around line 223). It currently looks like:

```tsx
  function startReplying() {
    setReplying(true);
```

Add the sheet snap immediately above the existing body:

```tsx
  const bottomSheet = useBottomSheet();
  function startReplying() {
    bottomSheet?.snapTo('expanded');
    setReplying(true);
```

(Place the `const bottomSheet = useBottomSheet();` line at the top of the enclosing component body, alongside the other hooks — wherever fits the existing pattern. The exact place will be obvious in context.)

- [ ] **Step 2: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/src/components/ThreadCard.tsx
git commit -m "feat(web): auto-expand bottom sheet when starting a reply"
```

---

### Task 10: Document route — mobile fork + sheet integration

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

The largest task. Adds a mobile/desktop fork driven by `useMediaQuery`, splits the header into mobile vs desktop variants, and renders the `BottomSheet` instead of the desktop sidebar on mobile.

- [ ] **Step 1: Add imports + mobile-detection hook**

At the top of `apps/web/src/routes/document.tsx`, add to the existing import block:

```tsx
import { BottomSheet, type SnapPoint } from '../components/BottomSheet.tsx';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
```

Inside `DocumentPage`, near the other top-of-component hook calls (after `const me = useMe();`), add:

```tsx
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [sheetSnap, setSheetSnap] = useState<SnapPoint>('handle');
```

- [ ] **Step 2: Drive sheet from existing events**

Add this effect near the other `useEffect` blocks (just below the `useEffect` that pushes focus to companion, around line 234):

```tsx
  // Mobile sheet automation. No-op on desktop because the sheet isn't rendered.
  useEffect(() => {
    if (!isMobile) return;
    if (pickMode) {
      setSheetSnap('handle');
    } else if (composerPending) {
      setSheetSnap('expanded');
    }
  }, [isMobile, pickMode, composerPending]);

  // Anchor click → peek (so iframe stays visible above the threads).
  // Must be inside onMessage's 'anchor_clicked' branch — see Step 3.
```

(Reference to `composerPending` — it is computed later in the function, in the existing render branch. To make the effect work we need to lift its definition or use the underlying state. The cleanest fix is in the next step.)

- [ ] **Step 3: Lift `composerPending` so the effect can see it**

The current code defines `composerPending` inside the render branch (line 306). Move that calculation up to the top-level component body, just above the new effect from Step 2:

```tsx
  const composerPending = readMostly
    ? null
    : pendingSelection
      ? { anchor: pendingSelection.anchor as AnchorData }
      : pendingPick
        ? { anchor: pendingPick.anchor as AnchorData }
        : null;
```

Delete the duplicate definition that exists inside the render branch (the `const composerPending = ...` line currently around 306, plus the `const { document } = docQuery.data;` line that pairs with it — keep `document` extraction).

After moving: confirm `composerPending` is used in the effect, in JSX, and in `pillPos` calculation. There should be only one definition.

- [ ] **Step 4: Snap to peek on anchor_clicked (mobile only)**

In `onMessage`, in the existing `case 'anchor_clicked':` block (around line 179), add a sheet snap immediately after the `setFocusedThreadId` call:

```tsx
        case 'anchor_clicked':
          setFocusedThreadId(msg.anchorId);
          setSidebarCollapsed(false);
          setSheetSnap('peek');
          requestAnimationFrame(() => {
            window.document.getElementById(`thread-${msg.anchorId}`)?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          });
          break;
```

`setSheetSnap` is a no-op visually on desktop because the sheet isn't rendered.

- [ ] **Step 5: Header — hide desktop-only authoring on mobile**

In the header JSX (around lines 327–462), wrap the desktop-only buttons with conditional classNames. Specifically:

The "Add Comment" / "Cancel" button (around line 366–376) — wrap with `hidden md:inline-flex`:

```tsx
          {!readMostly && (
            <button
              onClick={togglePickMode}
              className={`hidden md:inline-flex rounded px-3 py-1 text-sm ${
                pickMode
                  ? 'bg-red-600 text-white'
                  : 'border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800'
              }`}
            >
              {pickMode ? 'Cancel' : 'Add Comment'}
            </button>
          )}
```

The "+ Version" button (around 377–385) — add `hidden md:inline-flex`:

```tsx
          {isUploader && !readMostly && (
            <button
              type="button"
              onClick={() => setShowAddVersion(true)}
              className="hidden md:inline-flex rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              + Version
            </button>
          )}
```

The Export button (around 386–398) — wrap its outer attributes by adding `hidden md:inline-flex` to its className. Since it already has `inline-flex`, change `inline-flex items-center` to `hidden md:inline-flex items-center`.

The actions/delete menu (around 399–456) — wrap the outer `<div className="relative">` so the entire menu is hidden:

```tsx
          {isUploader && (
            <div className="relative hidden md:block">
```

The uploader info `<div className="text-sm text-neutral-500">…</div>` (around 457) — add `hidden md:block`:

```tsx
          <div className="hidden md:block text-sm text-neutral-500">
            {document.uploaderDisplayName} · {new Date(document.createdAt).toLocaleString()}
          </div>
```

Also reduce the header horizontal padding on mobile by changing the `<header>` className from `px-4` to `px-3 sm:px-4`.

- [ ] **Step 6: Layout fork — desktop sidebar vs mobile sheet**

Replace the existing `<div className="flex flex-1 overflow-hidden">` block (lines 480–504) with this:

```tsx
      <div className="flex flex-1 overflow-hidden">
        <div ref={iframeWrapperRef} className="flex-1 overflow-hidden">
          <ArtifactIframe
            src={`/api/versions/${currentVersionId}/content`}
            anchors={anchorsForCompanion}
            onMessage={onMessage}
            registerSender={registerSender}
          />
        </div>
        {!isMobile && (
          <CommentSidebar
            versionId={currentVersionId}
            currentUserId={me.data?.id ?? ''}
            pending={composerPending}
            onCancelPending={() => {
              setPendingSelection(null);
              setPendingPick(null);
            }}
            onSubmitPending={submitPending}
            onHighlight={onHighlight}
            positionsByAnchorId={positionsByAnchorId}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            focusedThreadId={focusedThreadId}
          />
        )}
      </div>

      {isMobile && !readMostly && (
        <BottomSheet
          snap={sheetSnap}
          onSnapChange={setSheetSnap}
          dragLocked={composerPending !== null}
          showBackdrop
          handleLabel={
            pickMode
              ? 'Picking element… (tap to cancel)'
              : `💬 ${threads.filter(hasLiveComments).length} comments`
          }
        >
          <CommentSidebar
            versionId={currentVersionId}
            currentUserId={me.data?.id ?? ''}
            pending={composerPending}
            onCancelPending={() => {
              setPendingSelection(null);
              setPendingPick(null);
            }}
            onSubmitPending={submitPending}
            onHighlight={onHighlight}
            positionsByAnchorId={positionsByAnchorId}
            focusedThreadId={focusedThreadId}
            onAddCommentClick={togglePickMode}
            addCommentActive={pickMode}
          />
        </BottomSheet>
      )}
```

Notes on the above:
- `readMostly` hides the sheet entirely on older versions — no commenting possible there, no UI needed.
- The sheet's `dragLocked` flips on while composing.
- Handle label switches between "Picking element…" and "💬 N comments" based on `pickMode`.
- The mobile `CommentSidebar` does NOT receive `collapsed`/`onCollapsedChange` — those are desktop-rail-only.

- [ ] **Step 7: Tapping the sheet handle while pickMode cancels pick**

We want a tap on the sheet handle in pickMode to call `togglePickMode`. The simplest, contained way: pass a custom `onHandleTap` is overkill. Instead, watch for the user dismissing to handle in pickMode (already does on dimmer click — no dimmer at handle, but the BottomSheet's handle click already toggles handle↔peek).

Replace the `pickMode ? 'Picking element… (tap to cancel)' : ...` handleLabel with a button-shaped element that intercepts the click. The simpler approach: keep the label as text, and add an `onSnapChange` override that calls `togglePickMode` when pickMode is active and the user tries to leave handle.

In `apps/web/src/routes/document.tsx`, wrap the `setSheetSnap` callback passed to the BottomSheet:

```tsx
          onSnapChange={(next) => {
            if (pickMode && next !== 'handle') {
              // User tried to expand the sheet while picking — interpret as cancel.
              send({ type: 'exit_pick_mode' });
              setPickMode(false);
              setSheetSnap('handle');
              return;
            }
            setSheetSnap(next);
          }}
```

Replace the original `onSnapChange={setSheetSnap}` line. Now a tap on the handle (which fires `onSnapChange('peek')`) during pick mode reroutes to a cancel.

- [ ] **Step 8: Hide the floating "Add comment in sidebar →" pill on mobile**

In the JSX block around line 506 (`{pillPos && pendingSelection && composerPending && (`), wrap with `!isMobile`:

```tsx
      {!isMobile && pillPos && pendingSelection && composerPending && (
        <div
          style={{ position: 'fixed', left: pillPos.left, top: pillPos.top, zIndex: 1000 }}
          className="flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          ...
        </div>
      )}
```

- [ ] **Step 9: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 10: Manual smoke (DevTools mobile emulation)**

Run dev:

```
pnpm dev
```

In Chrome DevTools, toggle device emulation → iPhone 14 Pro. Open a document.

Verify:
- Document header has compact buttons (only title, version selector visible).
- Bottom sheet is at handle, showing `💬 N comments`.
- Tap handle → snap to peek, threads visible.
- Drag handle up → snap to expanded with backdrop.
- Drag handle down → returns to peek then handle.
- Tap "+ Add comment" → sheet snaps to handle, label switches to "Picking element…".
- Tap an element in the iframe → composer opens at expanded.
- Tap Cancel in composer → sheet returns to handle.
- Tap a 💬 badge in iframe → sheet snaps to peek with that thread focused.

If anything is visibly broken (sheet flicker, layout overflow, drag stuck), fix inline and re-verify before committing.

- [ ] **Step 11: Commit**

```
git add apps/web/src/routes/document.tsx
git commit -m "feat(web): mobile layout fork on document route — bottom sheet"
```

---

### Task 11: Companion v1.js — touch path in pick mode

**Files:**
- Modify: `apps/api/src/companion/v1.js`

Two changes inside the iframe-side pick mode: skip the outline-preview on touch UAs, add a `touchend` fallback for tap-to-click synthesis, and render an in-iframe Cancel banner so mobile users can exit pick mode without an Escape key.

- [ ] **Step 1: Add touch detection helper**

Near the top of `apps/api/src/companion/v1.js`, after `safeStringify` (around line 49) but before the init handshake comment, add:

```js
  /** True when running in a UA without a hover-capable pointer (phones/tablets). */
  function isTouchUA() {
    try {
      return matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch (_) {
      return false;
    }
  }
```

- [ ] **Step 2: Modify enterPickMode**

Locate `enterPickMode` (around line 788) and replace its body so the touch path is gated:

```js
  function enterPickMode() {
    if (pickActive) return;
    pickActive = true;
    prevBodyCursor = document.body.style.cursor;

    if (isTouchUA()) {
      // Touch UAs: no outline preview (finger covers it), use `pointer` cursor
      // so iOS Safari reliably synthesizes click on non-button elements.
      document.body.style.cursor = 'pointer';
      ensurePickBanner();
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('touchend', onPickTouchEnd, true);
    } else {
      document.body.style.cursor = 'crosshair';
      pickOutline = document.createElement('div');
      pickOutline.className = '__primer_pick_outline__';
      ensureOverlay().appendChild(pickOutline);
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
    }
  }
```

- [ ] **Step 3: Modify exitPickMode**

Replace the existing `exitPickMode` body:

```js
  function exitPickMode(reason /* 'click' | 'esc' | 'parent' | 'banner' */) {
    if (!pickActive) return;
    pickActive = false;
    document.body.style.cursor = prevBodyCursor;
    pickOutline?.remove();
    pickOutline = null;
    removePickBanner();

    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('touchend', onPickTouchEnd, true);
    document.removeEventListener('keydown', onPickKey, true);

    // 'click' exits are implicit in element_picked; 'parent' was parent-initiated.
    // 'esc' and 'banner' are user-initiated from inside the iframe — parent
    // needs an explicit pick_mode_exited to revert its UI.
    if ((reason === 'esc' || reason === 'banner') && port) {
      port.postMessage({ type: 'pick_mode_exited' });
    }
  }
```

- [ ] **Step 4: Add onPickTouchEnd**

Add a new function next to `onPickClick`. The simplest correct behavior: when the user lifts their finger on an element while in pick mode AND the synthesized `click` hasn't already handled it, treat the touchend like a pick click.

Since `click` capture-listener runs first on most UAs, we use a flag `touchHandled` to avoid double-fire. Insert this near `onPickClick`:

```js
  let _pickInFlight = false;

  function onPickTouchEnd(e) {
    if (!pickActive || _pickInFlight) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const target = document.elementFromPoint(t.clientX, t.clientY);
    if (!(target instanceof Element)) return;
    _pickInFlight = true;
    // Synthesize the same flow as onPickClick.
    e.preventDefault();
    e.stopImmediatePropagation();
    void commitPick(target).finally(() => { _pickInFlight = false; });
  }
```

Then refactor `onPickClick` to delegate to a shared `commitPick`. Replace the existing `onPickClick` with:

```js
  async function onPickClick(e) {
    if (!pickActive || _pickInFlight) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    _pickInFlight = true;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      await commitPick(target);
    } finally {
      _pickInFlight = false;
    }
  }

  async function commitPick(target) {
    const path = cssPath(target);
    const rawText = normalize(target.textContent ?? '');
    const innerHash = (await sha256Hex(rawText)).slice(0, 16);
    const innerText = rawText.length > 160 ? `${rawText.slice(0, 160)}…` : rawText;
    const clientRect = serializeRect(target.getBoundingClientRect());

    exitPickMode('click');

    if (port) {
      port.postMessage({
        type: 'element_picked',
        anchor: { type: 'element-path', path, innerHash, innerText },
        clientRect,
      });
    }
  }
```

(The existing `onPickClick` body after the `e.preventDefault()` call moves into `commitPick`. Verify the resulting file by reading the section around `onPickClick` and the closing `}` of pick mode.)

- [ ] **Step 5: Add the in-iframe banner**

Add these functions near `ensureOverlay`:

```js
  const PICK_BANNER_ID = '__primer_pick_banner__';

  function ensurePickBanner() {
    let el = document.getElementById(PICK_BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PICK_BANNER_ID;
    el.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'background:#111',
      'color:#fff',
      'font:14px/1.4 system-ui, sans-serif',
      'padding:10px 14px',
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:12px',
    ].join(';') + ';';
    el.innerHTML = '<span>Tap an element to add a comment</span>';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:transparent;color:#fff;border:1px solid #555;padding:4px 10px;border-radius:4px;font:inherit;cursor:pointer;';
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      exitPickMode('banner');
    }, true);
    el.appendChild(cancel);
    document.body.appendChild(el);
    return el;
  }

  function removePickBanner() {
    const el = document.getElementById(PICK_BANNER_ID);
    if (el) el.remove();
  }
```

- [ ] **Step 6: Typecheck and test**

```
pnpm typecheck && pnpm test
```

Expected: PASS. (No existing tests on v1.js; the file is plain JS, tested via fixtures in the browser. typecheck on the api workspace still passes because v1.js is loaded as a static asset.)

- [ ] **Step 7: Manual smoke (DevTools mobile emulation)**

```
pnpm dev
```

DevTools → iPhone 14 Pro. Open a document.

Verify:
- Tap "+ Add comment" in the sheet → sheet snaps to handle, banner "Tap an element to add a comment · Cancel" appears at the top of the iframe.
- Tap an element in the iframe → composer opens at expanded snap, banner gone.
- Repeat → tap Cancel in banner → composer not opened, banner gone, sheet handle label returns to "💬 N comments".
- Repeat → tap the sheet handle while in pick mode → pick cancels (parent sends `exit_pick_mode`, banner clears).

Also verify desktop is unbroken: with DevTools device emulation OFF, "Add Comment" button still works, outline preview follows the cursor, ESC cancels, ESC reverts the parent UI.

- [ ] **Step 8: Commit**

```
git add apps/api/src/companion/v1.js
git commit -m "feat(commenting): touch path in companion pick mode"
```

---

## Pre-merge gate (NOT a task — a separate user-driven verification step)

Before pushing master (which auto-deploys to Railway):

- iOS Safari on a real phone: full read + reply + element-pick + compose flow. Confirm keyboard inset behavior matches expectations.
- Android Chrome spot-check.
- One more desktop pass on Chrome, Firefox, and Safari to confirm no regressions.

If real-device verification surfaces bugs, file them as follow-up commits (no additional plan needed unless the scope grows).

---

## Self-review

### Spec coverage

- Scope (read+comment, element-pick only on touch) → Tasks 8, 10, 11.
- Single `md` breakpoint → Task 6 (`useMediaQuery`), Tasks 2/3/10 (Tailwind `md:` classes).
- AppShell padding → Task 1.
- Home route → Task 3.
- Out-of-scope routes notice → Task 2.
- Bottom-sheet snap points (handle/peek/expanded) + drag → Tasks 5, 7.
- `+ Add comment` in sheet at peek/expanded → Task 8.
- Anchor↔thread linking (anchor click → peek + scroll) → Task 10 step 4.
- Compose lock (drag disabled while composing) → Task 7 (`dragLocked`), Task 10 step 6.
- Body scroll lock → Task 7 (`useEffect` in BottomSheet).
- Drag-handle vs content scroll → Task 7 (drag only on handle button; inner div is `overflow-y-auto`).
- Element-pick touch path + Cancel banner → Task 11.
- iOS Safari tap-to-click reliability → Task 11 (cursor + touchend fallback).
- Pick cancel paths (banner Cancel, sheet handle tap, ESC) → Task 11 step 5 + Task 10 step 7.
- Virtual keyboard handling (viewport meta + visualViewport fallback) → Tasks 1, 6.
- Mentions dropdown direction-aware → Task 4.
- Auto-focus on user gesture → Already in `NewThreadComposer` and `ThreadCard` reply; no change needed.
- Post-submit behavior (sheet stays expanded, scroll to new comment) → Existing query-invalidation refetch + sheet's natural state already satisfy this; no special handling required.
- Verification plan (Vitest, DevTools, real device) → Tasks 5/10/11 steps + pre-merge gate.

### Placeholder scan

No "TBD" / "TODO" / "fill in" / "appropriate error handling" / "etc." found. Every code block is concrete.

### Type consistency

- `SnapPoint` defined in `BottomSheet.snap.ts` (Task 5), imported into `BottomSheet.tsx` (Task 7), re-exported, and imported into `document.tsx` (Task 10) — same name everywhere.
- `useBottomSheet()` returns `BottomSheetCtx | null` in Task 7; consumed in ThreadCard via `?.snapTo(...)` in Task 9 — handles null correctly.
- Companion's new `commitPick(target)` is async and called from both `onPickClick` and `onPickTouchEnd` — both await/await-via-finally; `_pickInFlight` flag prevents double-fire.
- `exitPickMode` reason expanded from `'click' | 'esc' | 'parent'` to add `'banner'` — every call site uses one of the four; matched in Task 11 steps 3, 4 (`'click'`), 5 (`'banner'`).
