# Mobile Document View (Compact Header + Fit-to-Width Artifacts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the document page usable on phones: a compact header that gives the artifact the screen, and automatic fit-to-width scaling of artifacts that are intrinsically wider than the iframe.

**Architecture:** The companion script (inside every artifact iframe) measures intrinsic content overflow and reports it over the existing typed MessagePort protocol via a new `content_metrics` message. `ArtifactIframe` (parent side, mobile only) converts reports into a CSS `transform: scale()` fit, floored at 0.5×, using pure functions in `apps/web/src/lib/fitToWidth.ts`. The header's version selector + ⋯ menu are extracted into a `HeaderActions` component rendered twice (mobile row / desktop cluster); Share collapses into the menu on mobile; title/description get working line clamps.

**Tech Stack:** React 18 + TypeScript + Tailwind v4 (apps/web), plain-JS companion IIFE (apps/api/src/companion/v1.js), vitest (node environment — pure-function tests only), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-07-14-mobile-document-view-design.md` · **Issue:** #71 · **Branch:** `issue-71-mobile-document-view` (already created; spec committed)

## Global Constraints

- Package manager is **pnpm only** — never npm/npx.
- NixOS: before any `pnpm` command, ensure node is on PATH:
  `export PATH="$HOME/.local/bin:$PATH" && export PATH="$(dirname "$(which node 2>/dev/null || echo /nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin/node)"):$PATH"`
- **NEVER `git push`** (any branch) without the user's explicit greenlight in the current turn — master auto-deploys to Railway.
- Commit messages: Conventional Commits, footer `Refs: #71`, plus trailers
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01Rw5hPqMjCgcVdbgcnonCad`.
- **Do NOT touch the iframe `sandbox` attribute** in `ArtifactIframe.tsx` (security-critical; see comment in that file). The style/wrapper changes in Task 4 must leave `sandbox="allow-scripts allow-forms allow-modals allow-downloads"` byte-identical.
- Do NOT remove PR #70's viewport-meta injection (upload pipeline or companion) — kept per spec.
- `@primer/shared` is consumed as TypeScript source (`"." : "./src/index.ts"`) — no build step between packages.
- Fit constants (single source of truth in `apps/web/src/lib/fitToWidth.ts`): scale floor **0.5**, overflow tolerance **1.02** (content must exceed container by >2%). The companion duplicates the 1.02 tolerance as a literal (plain-JS IIFE, can't import) — both sites carry "keep in sync" comments.
- Desktop (`md`+) must remain visually unchanged except: iframe height goes from `calc(100vh - 120px)` to filling its wrapper (more correct; verify no visual regression).

---

### Task 1: Protocol — `content_metrics` inbound message

**Files:**
- Modify: `packages/shared/src/companion-protocol.ts` (message interfaces ~line 117-149, parser ~line 210-267)
- Test: `apps/web/src/companion/protocol.test.ts`

**Interfaces:**
- Consumes: existing `parseInboundMessage(raw: unknown): InboundProtocolMessage | null`, `isNumber()` helper.
- Produces: `interface MsgContentMetrics { type: 'content_metrics'; contentWidth: number }`, added to the `InboundProtocolMessage` union and handled by `parseInboundMessage`. Tasks 2 and 4 rely on the exact shape `{ type: 'content_metrics', contentWidth: <finite px number > 0> }`.

- [ ] **Step 1: Write the failing tests**

Append to the `parseInboundMessage` describe block in `apps/web/src/companion/protocol.test.ts`:

```ts
it('round-trips content_metrics', () => {
  expect(parseInboundMessage({ type: 'content_metrics', contentWidth: 812 })).toEqual({
    type: 'content_metrics',
    contentWidth: 812,
  });
});

it('rejects content_metrics without a positive finite width', () => {
  expect(parseInboundMessage({ type: 'content_metrics' })).toBeNull();
  expect(parseInboundMessage({ type: 'content_metrics', contentWidth: 0 })).toBeNull();
  expect(parseInboundMessage({ type: 'content_metrics', contentWidth: -5 })).toBeNull();
  expect(parseInboundMessage({ type: 'content_metrics', contentWidth: Infinity })).toBeNull();
  expect(parseInboundMessage({ type: 'content_metrics', contentWidth: '900' })).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C apps/web test -- protocol`
Expected: FAIL — `content_metrics` currently hits the parser's `default: return null`, so the round-trip test gets `null`.

- [ ] **Step 3: Implement the message**

In `packages/shared/src/companion-protocol.ts`, after `MsgResize` (~line 120), add:

```ts
/** Fired when the artifact's content is intrinsically wider than the iframe
 *  viewport (companion only sends it on overflow, never for fitting
 *  content). The parent uses it to scale the iframe down to fit narrow
 *  screens. */
export interface MsgContentMetrics {
  type: 'content_metrics';
  contentWidth: number;
}
```

Add `| MsgContentMetrics` to the `InboundProtocolMessage` union. In `parseInboundMessage`, after the `'resize'` case, add:

```ts
    case 'content_metrics': {
      if (!isNumber(raw.contentWidth) || raw.contentWidth <= 0) return null;
      return { type: 'content_metrics', contentWidth: raw.contentWidth };
    }
```

(`isNumber` already requires `Number.isFinite`, so `Infinity` is rejected.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C apps/web test -- protocol && pnpm -C packages/shared typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/companion-protocol.ts apps/web/src/companion/protocol.test.ts
git commit -m "feat(shared): add content_metrics companion message

Refs: #71"
```
(Include the two standard trailers from Global Constraints in this and every commit below.)

---

### Task 2: Companion — measure and report intrinsic content width

**Files:**
- Modify: `apps/api/src/companion/v1.js` (insert before the `// ── Resize observer ──` section at ~line 1586; hook into the `ro` callback and the init handler)
- Test: `apps/api/src/companion/contentMetrics.test.ts` (new, mirrored-logic pattern like `mermaidScanner.test.ts`)

**Interfaces:**
- Consumes: companion-internal `port` (MessagePort, set in the init handler ~line 367).
- Produces: posts `{ type: 'content_metrics', contentWidth }` (Task 1 shape) whenever `max(documentElement.scrollWidth, body.scrollWidth) > documentElement.clientWidth * 1.02` and the value is new. Debounced 150ms.

- [ ] **Step 1: Write the failing mirror test**

Create `apps/api/src/companion/contentMetrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

// Mirrored from the reporting guard in companion/v1.js
// (reportContentMetrics); keep in sync. The companion is a plain-JS IIFE,
// so the decision logic is mirrored here rather than imported — same
// pattern as mermaidScanner.test.ts.
function shouldReportContentWidth(
  contentWidth: number,
  clientWidth: number,
  lastReported: number,
): boolean {
  if (!(contentWidth > 0) || !(clientWidth > 0)) return false;
  if (contentWidth <= clientWidth * 1.02) return false;
  if (contentWidth === lastReported) return false;
  return true;
}

describe('companion content-metrics reporting guard (mirror)', () => {
  it('does not report content that fits', () => {
    expect(shouldReportContentWidth(390, 390, 0)).toBe(false);
  });

  it('does not report within the 2% tolerance', () => {
    expect(shouldReportContentWidth(397, 390, 0)).toBe(false); // 390*1.02 = 397.8
  });

  it('reports genuine overflow', () => {
    expect(shouldReportContentWidth(800, 390, 0)).toBe(true);
  });

  it('suppresses duplicate reports of the same width', () => {
    expect(shouldReportContentWidth(800, 390, 800)).toBe(false);
  });

  it('reports again when content grows past the last report', () => {
    expect(shouldReportContentWidth(1000, 800, 800)).toBe(true); // overflows 800*1.02=816 and differs from last report
  });

  it('rejects degenerate measurements', () => {
    expect(shouldReportContentWidth(0, 390, 0)).toBe(false);
    expect(shouldReportContentWidth(800, 0, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify current state**

Run: `pnpm -C apps/api test -- contentMetrics`
Expected: PASS immediately (mirror tests validate the spec'd logic, not the wiring). That is fine — the deliverable being tested is the guard contract; proceed.

- [ ] **Step 3: Implement in the companion**

In `apps/api/src/companion/v1.js`, insert immediately BEFORE the `// ── Resize observer ──` section (~line 1586):

```js
  // ── Content width reporting (fit-to-width) ───────────────────────
  // The parent scales the iframe down on narrow screens when the artifact
  // is intrinsically wider than the container. Only overflow is reported
  // (scrollWidth > clientWidth * 1.02) and only when the value changes.
  // Guard logic mirrored in contentMetrics.test.ts; tolerance mirrored in
  // apps/web/src/lib/fitToWidth.ts (FIT_OVERFLOW_TOLERANCE). Keep in sync.
  let lastReportedContentWidth = 0;
  let contentMetricsTimer = null;

  function reportContentMetrics() {
    if (!port) return;
    try {
      const doc = document.documentElement;
      const body = document.body;
      const clientWidth = doc ? doc.clientWidth : 0;
      const contentWidth = Math.max(
        doc ? doc.scrollWidth : 0,
        body ? body.scrollWidth : 0,
      );
      if (!(contentWidth > 0) || !(clientWidth > 0)) return;
      if (contentWidth <= clientWidth * 1.02) return;
      if (contentWidth === lastReportedContentWidth) return;
      lastReportedContentWidth = contentWidth;
      port.postMessage({ type: 'content_metrics', contentWidth });
    } catch (e) {
      // Non-fatal: fit-to-width just won't engage.
    }
  }

  function scheduleContentMetrics() {
    if (contentMetricsTimer !== null) return;
    contentMetricsTimer = setTimeout(function () {
      contentMetricsTimer = null;
      reportContentMetrics();
    }, 150);
  }
```

Hook it up in two places:

1. Inside the existing ResizeObserver callback (~line 1588), add one line after the `port.postMessage({ type: 'resize', ... })` block:

```js
    scheduleContentMetrics();
```

2. In the init handler (`onWindowMessage`, ~line 402), immediately after `flushLogBuffer();`:

```js
    scheduleContentMetrics();
```

- [ ] **Step 4: Verify suites and typecheck**

Run: `pnpm -C apps/api test && pnpm -C apps/api typecheck`
Expected: all API tests pass (636 + 6 new), typecheck clean. (v1.js has no direct unit tests; the companion route test asserts it serves — unchanged.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/companion/v1.js apps/api/src/companion/contentMetrics.test.ts
git commit -m "feat(companion): report intrinsic content width for fit-to-width

Refs: #71"
```

---

### Task 3: Web — fit-to-width pure math (`fitToWidth.ts`)

**Files:**
- Create: `apps/web/src/lib/fitToWidth.ts`
- Test: `apps/web/src/lib/fitToWidth.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (Task 4 relies on these exact signatures):
  - `type FitState = { contentWidth: number } | null`
  - `nextFitState(current: FitState, reportedContentWidth: number, containerWidth: number): FitState`
  - `computeFitScale(state: FitState, containerWidth: number): number`
  - `fitIframeStyle(scale: number, state: FitState): { width: string; height: string; transform?: string; transformOrigin?: string }`
  - `hasResidualOverflow(scale: number, state: FitState, containerWidth: number): boolean`
  - `FIT_SCALE_FLOOR = 0.5`, `FIT_OVERFLOW_TOLERANCE = 1.02`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/fitToWidth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  FIT_SCALE_FLOOR,
  computeFitScale,
  fitIframeStyle,
  hasResidualOverflow,
  nextFitState,
} from './fitToWidth.ts';

describe('nextFitState', () => {
  it('stays null for reports that fit the container within tolerance', () => {
    expect(nextFitState(null, 395, 390)).toBeNull(); // 390*1.02 = 397.8
  });

  it('starts tracking on the first overflowing report', () => {
    expect(nextFitState(null, 800, 390)).toEqual({ contentWidth: 800 });
  });

  it('grows only — a smaller report never shrinks the layout width', () => {
    expect(nextFitState({ contentWidth: 800 }, 600, 390)).toEqual({ contentWidth: 800 });
    expect(nextFitState({ contentWidth: 800 }, 1000, 390)).toEqual({ contentWidth: 1000 });
  });

  it('ignores degenerate reports', () => {
    expect(nextFitState(null, 0, 390)).toBeNull();
    expect(nextFitState(null, -10, 390)).toBeNull();
    expect(nextFitState(null, Number.NaN, 390)).toBeNull();
    expect(nextFitState({ contentWidth: 800 }, Number.NaN, 390)).toEqual({ contentWidth: 800 });
  });

  it('tracks overflow even when containerWidth is unknown (0)', () => {
    // Before the wrapper is measured we still record the report; the scale
    // computation guards on containerWidth separately.
    expect(nextFitState(null, 800, 0)).toEqual({ contentWidth: 800 });
  });
});

describe('computeFitScale', () => {
  it('is 1 with no fit state or unknown container', () => {
    expect(computeFitScale(null, 390)).toBe(1);
    expect(computeFitScale({ contentWidth: 800 }, 0)).toBe(1);
  });

  it('is 1 when the container now fits the content (e.g. after rotation)', () => {
    expect(computeFitScale({ contentWidth: 800 }, 844)).toBe(1);
  });

  it('scales proportionally between the floor and 1', () => {
    expect(computeFitScale({ contentWidth: 600 }, 390)).toBeCloseTo(0.65, 10);
  });

  it('floors at 0.5 for degenerate ultra-wide content', () => {
    expect(computeFitScale({ contentWidth: 3000 }, 390)).toBe(FIT_SCALE_FLOOR);
  });
});

describe('fitIframeStyle', () => {
  it('renders a natural 100% box at scale 1', () => {
    expect(fitIframeStyle(1, null)).toEqual({ width: '100%', height: '100%' });
    expect(fitIframeStyle(1, { contentWidth: 800 })).toEqual({ width: '100%', height: '100%' });
  });

  it('widens the layout box and scales it back down when scaled', () => {
    expect(fitIframeStyle(0.65, { contentWidth: 600 })).toEqual({
      width: '600px',
      height: `${100 / 0.65}%`,
      transform: 'scale(0.65)',
      transformOrigin: 'top left',
    });
  });
});

describe('hasResidualOverflow', () => {
  it('is false at 1:1 or when the floored scale still fits', () => {
    expect(hasResidualOverflow(1, null, 390)).toBe(false);
    expect(hasResidualOverflow(0.65, { contentWidth: 600 }, 390)).toBe(false); // 600*0.65 = 390
  });

  it('is true when even the floor cannot fit the content', () => {
    expect(hasResidualOverflow(0.5, { contentWidth: 3000 }, 390)).toBe(true); // 1500 > 390
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C apps/web test -- fitToWidth`
Expected: FAIL — module `./fitToWidth.ts` does not exist.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/fitToWidth.ts`:

```ts
/** Fit-to-width scaling math for the artifact iframe on narrow screens.
 *
 * The companion reports the artifact's intrinsic content width when it
 * overflows the iframe viewport (see companion/v1.js reportContentMetrics
 * and MsgContentMetrics in @primer/shared). The parent converts that into
 * a CSS transform scale. All decision logic lives here as pure functions
 * so the node-environment test suite covers it. */

export const FIT_SCALE_FLOOR = 0.5;

/** Content must exceed the container by >2% before fit-to-width engages —
 * sub-pixel rounding and scrollbar noise must not trigger a zoom-out.
 * Mirrored as a literal in the companion's reporting guard; keep in sync. */
export const FIT_OVERFLOW_TOLERANCE = 1.02;

/** Widest content width (px) the companion has reported for the current
 * document version. Null = render 1:1. */
export type FitState = { contentWidth: number } | null;

/** Grow-only accumulator: reports never shrink the layout width, which
 * prevents reflow→re-measure oscillation (widening the iframe reflows the
 * content, which fires a new measurement). The caller resets the state on
 * src change; rotation is handled by computeFitScale reading the live
 * container width. */
export function nextFitState(
  current: FitState,
  reportedContentWidth: number,
  containerWidth: number,
): FitState {
  if (!Number.isFinite(reportedContentWidth) || reportedContentWidth <= 0) return current;
  if (containerWidth > 0 && reportedContentWidth <= containerWidth * FIT_OVERFLOW_TOLERANCE) {
    return current;
  }
  if (current && reportedContentWidth <= current.contentWidth) return current;
  return { contentWidth: reportedContentWidth };
}

export function computeFitScale(state: FitState, containerWidth: number): number {
  if (!state || containerWidth <= 0) return 1;
  if (containerWidth * FIT_OVERFLOW_TOLERANCE >= state.contentWidth) return 1;
  return Math.max(FIT_SCALE_FLOOR, Math.min(1, containerWidth / state.contentWidth));
}

/** Inline styles for the iframe. At scale 1 the iframe naturally fills its
 * wrapper; below 1 it lays out at the content's intrinsic width and is
 * transform-scaled back down to fit. Height compensates (100/scale %) so
 * the scaled result still fills the wrapper vertically. */
export function fitIframeStyle(
  scale: number,
  state: FitState,
): { width: string; height: string; transform?: string; transformOrigin?: string } {
  if (scale >= 1 || !state) return { width: '100%', height: '100%' };
  return {
    width: `${state.contentWidth}px`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
  };
}

/** True when even the floored scale cannot fit the content — the wrapper
 * must then allow horizontal panning instead of clipping. */
export function hasResidualOverflow(
  scale: number,
  state: FitState,
  containerWidth: number,
): boolean {
  if (!state || scale >= 1) return false;
  return state.contentWidth * scale > containerWidth + 1;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C apps/web test -- fitToWidth`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/fitToWidth.ts apps/web/src/lib/fitToWidth.test.ts
git commit -m "feat(web): add fit-to-width scaling math

Refs: #71"
```

---

### Task 4: `ArtifactIframe` — apply fit-to-width on mobile

**Files:**
- Modify: `apps/web/src/components/ArtifactIframe.tsx`
- Modify: `apps/web/src/routes/document.tsx` (~line 752: pass `fitToWidth={isMobile}`)
- Test: covered by Task 3's pure functions + typecheck + existing suites (node test env — no DOM component tests in this repo).

**Interfaces:**
- Consumes: `FitState`, `nextFitState`, `computeFitScale`, `fitIframeStyle`, `hasResidualOverflow` from `../lib/fitToWidth.ts` (Task 3); `content_metrics` messages (Tasks 1–2).
- Produces: new optional prop `fitToWidth?: boolean` on `ArtifactIframe` (default false → desktop and `devHarness.tsx` behavior unchanged, apart from the wrapper/height change below). `content_metrics` is consumed locally and NOT forwarded to the route's `onMessage`.

- [ ] **Step 1: Update the component**

In `apps/web/src/components/ArtifactIframe.tsx`:

1. Add imports:

```ts
import { useEffect, useRef, useState } from 'react';
import {
  computeFitScale,
  fitIframeStyle,
  hasResidualOverflow,
  nextFitState,
  type FitState,
} from '../lib/fitToWidth.ts';
```

2. Add `fitToWidth?: boolean;` to `Props` with doc comment:

```ts
  /** Scale content down (to at most 0.5×) when the artifact is intrinsically
   * wider than the container. Enabled by the document route on mobile. */
  fitToWidth?: boolean;
```

3. Inside the component (alongside the existing refs), add:

```ts
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<FitState>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const fitToWidthRef = useRef(fitToWidth === true);
  useEffect(() => { fitToWidthRef.current = fitToWidth === true; }, [fitToWidth]);

  // New document/version → forget the previous artifact's width.
  useEffect(() => { setFit(null); }, [src]);

  // Track the wrapper's width so the scale follows rotation and layout
  // changes. Observing unconditionally keeps hook order stable and is cheap.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
```

4. In `sendInit`, replace the `port.onmessage` handler body:

```ts
      port.onmessage = (event) => {
        const parsed = parseInboundMessage(event.data);
        if (!parsed) return;
        if (parsed.type === 'content_metrics') {
          // Rendering concern owned by this component — not forwarded.
          if (fitToWidthRef.current) {
            setFit((cur) =>
              nextFitState(cur, parsed.contentWidth, wrapRef.current?.clientWidth ?? 0),
            );
          }
          return;
        }
        onMessageRef.current(parsed);
      };
```

5. Replace the `return (...)` JSX. The `sandbox` attribute is copied verbatim — do not edit it:

```tsx
  const scale = fitToWidth ? computeFitScale(fit, containerWidth) : 1;
  const fitStyle = fitIframeStyle(scale, fit);
  const allowPanX = fitToWidth ? hasResidualOverflow(scale, fit, containerWidth) : false;

  return (
    <div
      ref={wrapRef}
      className="h-full w-full"
      style={{ overflowX: allowPanX ? 'auto' : 'hidden', overflowY: 'hidden' }}
    >
      <iframe
        ref={iframeRef}
        src={src}
        sandbox="allow-scripts allow-forms allow-modals allow-downloads"
        title="Artifact"
        style={{ border: 0, display: 'block', ...fitStyle }}
      />
    </div>
  );
```

Note the height change: the iframe previously hardcoded `calc(100vh - 120px)`; it now fills its wrapper (`100%` or `100/scale %`). The wrapper chain in `document.tsx` (`flex flex-col h-[calc(100vh-60px)]` → `flex flex-1 overflow-hidden` → `flex-1 overflow-hidden`) provides a definite height, so `h-full` resolves. This also makes the read-only version banner stop eating into a fudged constant.

- [ ] **Step 2: Pass the prop from the document route**

In `apps/web/src/routes/document.tsx` (~line 752), add `fitToWidth={isMobile}`:

```tsx
          <ArtifactIframe
            src={`/api/versions/${currentVersionId}/content`}
            anchors={anchorsForCompanion}
            theme={theme}
            fitToWidth={isMobile}
            onMessage={onMessage}
            registerSender={registerSender}
          />
```

`devHarness.tsx` needs no change (prop optional).

- [ ] **Step 3: Typecheck and run the web suite**

Run: `pnpm -C apps/web typecheck && pnpm -C apps/web test`
Expected: typecheck clean; all tests pass (195 + new). If typecheck flags the route's `onMessage` switch over `InboundProtocolMessage` (it now includes `content_metrics` with no case): the switch has no default and no exhaustiveness assertion, so no error is expected — if one appears, do NOT add a `content_metrics` case to the route; the message never reaches it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ArtifactIframe.tsx apps/web/src/routes/document.tsx
git commit -m "feat(web): scale overflowing artifacts to fit on mobile

Refs: #71"
```

---

### Task 5: Menu — `share` entry via `buildMenuItems`

**Files:**
- Modify: `apps/web/src/lib/documentActionsMenu.ts`
- Test: `apps/web/src/lib/documentActionsMenu.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MenuItemId` gains `'share'`; `MenuInput` gains `includeShare?: boolean`. When `includeShare && isUploader`, the returned list starts with `{ id: 'share', label: 'Share…' }` followed by a separator. Task 6 maps `'share'` to its `onShare` prop.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/documentActionsMenu.test.ts`:

```ts
it('puts a share entry first when includeShare is set for the uploader', () => {
  const items = buildMenuItems({ isUploader: true, includeShare: true });
  expect(items[0]).toEqual({ id: 'share', label: 'Share…' });
  expect(items[1]).toEqual({ id: 'separator' });
});

it('omits share for non-uploaders even when includeShare is set', () => {
  const ids = buildMenuItems({ isUploader: false, includeShare: true }).map((i) => i.id);
  expect(ids).not.toContain('share');
});

it('omits share when includeShare is absent', () => {
  const ids = buildMenuItems({ isUploader: true }).map((i) => i.id);
  expect(ids).not.toContain('share');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C apps/web test -- documentActionsMenu`
Expected: FAIL — no `share` id exists and `includeShare` is not a valid input property (TS error surfaces at test compile).

- [ ] **Step 3: Implement**

In `apps/web/src/lib/documentActionsMenu.ts`:

```ts
export type MenuItemId =
  | 'share'
  | 'open-fullscreen'
  | 'download-html'
  | 'copy'
  | 'download'
  | 'separator'
  | 'delete';

export interface MenuItem {
  id: MenuItemId;
  label?: string;
  destructive?: boolean;
}

export interface MenuInput {
  isUploader: boolean;
  /** Mobile collapses the Share button into the menu. */
  includeShare?: boolean;
}

/** Pure function: given who's viewing, return the ordered menu items. The
 *  caller maps each item to a click handler. */
export function buildMenuItems({ isUploader, includeShare = false }: MenuInput): MenuItem[] {
  const items: MenuItem[] = [];
  if (includeShare && isUploader) {
    items.push({ id: 'share', label: 'Share…' });
    items.push({ id: 'separator' });
  }
  items.push(
    { id: 'open-fullscreen', label: 'Open full screen' },
    { id: 'download-html', label: 'Download HTML' },
    { id: 'separator' },
    { id: 'copy', label: 'Copy comments as Markdown' },
    { id: 'download', label: 'Download comments as Markdown' },
  );
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: 'Delete document…', destructive: true });
  }
  return items;
}
```

Note: `document.tsx`'s existing `onClickFor` record (`Record<Exclude<MenuItemId, 'separator'>, () => void>`) will now fail typecheck because `'share'` is missing — that is expected and gets resolved by Tasks 6–7 (the record moves into `HeaderActions`). To keep this commit green, add a temporary entry in `document.tsx`'s `onClickFor` map (~line 625):

```ts
                    share: () => {
                      setActionsMenuState('closed');
                      setShowShare(true);
                    },
```

(Task 7 deletes this whole block.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C apps/web test -- documentActionsMenu && pnpm -C apps/web typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/documentActionsMenu.ts apps/web/src/lib/documentActionsMenu.test.ts apps/web/src/routes/document.tsx
git commit -m "feat(web): support a share entry in the document actions menu

Refs: #71"
```

---

### Task 6: `HeaderActions` component

**Files:**
- Create: `apps/web/src/components/HeaderActions.tsx`
- Test: pure logic already covered (Task 5); component is JSX orchestration — typecheck only (node test env).

**Interfaces:**
- Consumes: `VersionSelector` (`docId: string, versions: VersionSummaryDTO[], currentVersionNumber: number, isViewingLatest: boolean, onAddVersion?: () => void`), `buildMenuItems` + `MenuItemId` (Task 5).
- Produces (Task 7 relies on these exact names):
  - `export interface ActionFeedback { kind: 'success' | 'error'; message: string }`
  - `export function HeaderActions(props)` with props: `variant: 'mobile' | 'desktop'`, `docId: string`, `versions: VersionSummaryDTO[]`, `currentVersionNumber: number`, `isViewingLatest: boolean`, `onAddVersion?: () => void`, `isUploader: boolean`, `onShare: () => void`, `onOpenFullScreen: () => void`, `onDownloadHtml: () => Promise<ActionFeedback | null>`, `onCopyComments: () => Promise<ActionFeedback>`, `onExportComments: () => void`, `onDelete: () => Promise<void>`.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/HeaderActions.tsx`. The button/menu/confirm/feedback JSX and classes are ported verbatim from `document.tsx` lines 563–701 — only the state names change:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { VersionSummaryDTO } from '@primer/shared';
import { VersionSelector } from './VersionSelector.tsx';
import { buildMenuItems, type MenuItemId } from '../lib/documentActionsMenu.ts';

export interface ActionFeedback {
  kind: 'success' | 'error';
  message: string;
}

interface Props {
  /** 'mobile' collapses Share into the ⋯ menu; 'desktop' shows the Share
   * button. The caller gates visibility per breakpoint (md:hidden vs
   * hidden md:flex), so each instance owns its popover state and
   * outside-click handling without cross-instance ref clashes. */
  variant: 'mobile' | 'desktop';
  docId: string;
  versions: VersionSummaryDTO[];
  currentVersionNumber: number;
  isViewingLatest: boolean;
  onAddVersion?: () => void;
  isUploader: boolean;
  onShare: () => void;
  onOpenFullScreen: () => void;
  /** Resolves to feedback to surface next to the menu; null = silent success. */
  onDownloadHtml: () => Promise<ActionFeedback | null>;
  onCopyComments: () => Promise<ActionFeedback>;
  onExportComments: () => void;
  onDelete: () => Promise<void>;
}

type MenuState = 'closed' | 'menu' | 'confirm';

export function HeaderActions({
  variant,
  docId,
  versions,
  currentVersionNumber,
  isViewingLatest,
  onAddVersion,
  isUploader,
  onShare,
  onOpenFullScreen,
  onDownloadHtml,
  onCopyComments,
  onExportComments,
  onDelete,
}: Props) {
  const [menuState, setMenuState] = useState<MenuState>('closed');
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (menuState !== 'menu') return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuState('closed');
      }
    }
    window.document.addEventListener('mousedown', onDown);
    return () => window.document.removeEventListener('mousedown', onDown);
  }, [menuState]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  function showFeedback(
    fb: ActionFeedback,
    dismissMs: number = fb.kind === 'error' ? 3000 : 2000,
  ) {
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    setFeedback(fb);
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, dismissMs);
  }

  const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
    share: () => {
      setMenuState('closed');
      onShare();
    },
    'open-fullscreen': () => {
      setMenuState('closed');
      onOpenFullScreen();
    },
    'download-html': () => {
      setMenuState('closed');
      void onDownloadHtml().then((fb) => {
        if (fb) showFeedback(fb);
      });
    },
    copy: () => {
      setMenuState('closed');
      void onCopyComments().then((fb) => showFeedback(fb));
    },
    download: () => {
      setMenuState('closed');
      onExportComments();
    },
    delete: () => setMenuState('confirm'),
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {versions.length > 0 && (
        <VersionSelector
          docId={docId}
          versions={versions}
          currentVersionNumber={currentVersionNumber}
          isViewingLatest={isViewingLatest}
          onAddVersion={onAddVersion}
        />
      )}
      {variant === 'desktop' && isUploader && (
        <button
          type="button"
          onClick={onShare}
          className="inline-flex h-7 items-center rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Share
        </button>
      )}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuState((s) => (s === 'closed' ? 'menu' : 'closed'))}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuState !== 'closed'}
          className="inline-flex h-7 items-center justify-center rounded border border-neutral-300 bg-white px-2 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {menuState === 'menu' && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 w-56 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-800 dark:bg-neutral-900"
          >
            {buildMenuItems({ isUploader, includeShare: variant === 'mobile' }).map(
              (item, index) => {
                if (item.id === 'separator') {
                  return (
                    <div
                      key={`sep-${index}`}
                      className="my-1 border-t border-neutral-200 dark:border-neutral-800"
                      aria-hidden="true"
                    />
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onClick={onClickFor[item.id]}
                    className={`block w-full px-3 py-1.5 text-left text-xs ${
                      item.destructive
                        ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                        : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              },
            )}
          </div>
        )}
        {menuState === 'confirm' && (
          <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              Delete this document? You can restore it within 30 days from the home page.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMenuState('closed')}
                className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onDelete();
                  setMenuState('closed');
                }}
                className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        )}
        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className={`absolute right-0 z-10 mt-1 rounded border px-2 py-1 text-xs shadow-md ${
              feedback.kind === 'success'
                ? 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
                : 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400'
            }`}
          >
            {feedback.message}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: clean. (Component is not yet referenced; that's fine.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/HeaderActions.tsx
git commit -m "feat(web): extract HeaderActions cluster component

Refs: #71"
```

---

### Task 7: Document header restructure + working clamps

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

**Interfaces:**
- Consumes: `HeaderActions`, `ActionFeedback` (Task 6).
- Produces: the final mobile/desktop header. No exports change.

- [ ] **Step 1: Refactor the feedback-producing handlers**

In `document.tsx`:

1. Import: `import { HeaderActions, type ActionFeedback } from '../components/HeaderActions.tsx';`
2. Change `downloadHtml` to return feedback instead of setting state:

```ts
  async function downloadHtml(): Promise<ActionFeedback | null> {
    if (!docQuery.data || !currentVersionId) return null;
    try {
      const res = await fetch(`/api/versions/${currentVersionId}/content`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = htmlFilename(
        { title: docQuery.data.document.title },
        { versionNumber: currentVersionNumber },
      );
      a.style.display = 'none';
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return null;
    } catch {
      return { kind: 'error', message: 'Download failed. Try again.' };
    }
  }
```

3. Change `copyComments` likewise:

```ts
  async function copyComments(): Promise<ActionFeedback> {
    if (!docQuery.data) return { kind: 'error', message: 'Comments not loaded yet.' };
    const md = formatThreadsAsMarkdown(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
      threads,
    );
    const result = await copyText(md);
    return result === 'failed'
      ? { kind: 'error', message: 'Copy failed. Try Download instead.' }
      : { kind: 'success', message: 'Copied' };
  }
```

4. Delete, now unused: the `copyFeedback` state declaration, `copyFeedbackTimerRef`, the unmount-cleanup effect that clears that timer, `showFeedback()`, the `actionsMenuState` state, `actionsMenuRef`, and the outside-click effect (currently ~lines 372–381). `openFullScreen` and `exportComments` stay as-is.

- [ ] **Step 2: Restructure the header JSX**

Replace the `<header>` block (currently lines 513–732) with:

```tsx
      <header className="border-b border-neutral-200 px-3 pb-2 pt-1 dark:border-neutral-800 sm:px-4 md:flex md:items-baseline md:justify-between md:gap-3">
        {/* Mobile top row: breadcrumb (or spacer) + compact actions. */}
        <div className="mb-0.5 flex items-center justify-between gap-2 md:hidden">
          {currentFolder ? (
            <Link
              to={`/?folder=${encodeURIComponent(currentFolder.id)}`}
              className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              ← {currentFolder.name}
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <HeaderActions variant="mobile" {...headerActionsProps} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          {currentFolder && (
            <Link
              to={`/?folder=${encodeURIComponent(currentFolder.id)}`}
              className="mb-1 hidden items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 md:inline-flex"
            >
              ← {currentFolder.name}
            </Link>
          )}
          <div className="flex min-w-0 items-center gap-2">
            {document.visibility === 'private' && (
              <PrivateLockIcon className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
            )}
            <EditableField
              value={document.title}
              placeholder="Add a title"
              canEdit={canEdit}
              displayClassName="text-lg md:text-xl font-semibold line-clamp-2 md:line-clamp-none"
              maxLength={200}
              ariaLabel="Document title"
              onSave={async (next) => {
                if (next === null || next.trim().length === 0) {
                  throw new Error('Title cannot be empty');
                }
                await editDoc.mutateAsync({ title: next });
              }}
            />
            {docQuery.data?.document.externallyShared && (
              <span
                title="This document has an active external share"
                className="ml-2 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 px-2 py-0.5 text-[11px] font-medium align-middle"
              >
                Shared externally
              </span>
            )}
          </div>
          <EditableField
            value={document.description}
            placeholder="Add a description"
            canEdit={canEdit}
            multiline
            displayClassName="max-w-[60ch] break-words text-sm text-neutral-600 dark:text-neutral-400 line-clamp-2 md:line-clamp-none"
            maxLength={2000}
            ariaLabel="Document description"
            onSave={async (next) => {
              await editDoc.mutateAsync({ description: next });
            }}
          />
        </div>
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          <div className="flex items-center gap-1.5">
            {libDoc && (
              <DocDetailFolderControl
                docId={libDoc.id}
                currentFolderId={libDoc.folderId}
                currentFolderName={currentFolder?.name ?? null}
                folders={libraryQ.data?.folders ?? []}
              />
            )}
            <HeaderActions variant="desktop" {...headerActionsProps} />
          </div>
          {!readMostly && (
            <button
              type="button"
              onClick={togglePickMode}
              className={`hidden h-7 items-center rounded px-3 text-xs font-medium md:inline-flex ${
                pickMode
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200'
              }`}
            >
              {pickMode ? 'Cancel' : '+ Add Comment'}
            </button>
          )}
          <div className="hidden items-center gap-3 md:flex">
            <div className="h-4 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />
            <div className="flex h-7 flex-col justify-center text-right leading-tight">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {document.uploaderDisplayName}
              </span>
              <span
                className="text-[10px] text-neutral-500"
                title={new Date(document.createdAt).toLocaleString()}
              >
                {relativeTime(document.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </header>
```

Define `headerActionsProps` just above the `return` (after `const { document } = docQuery.data;`):

```tsx
  const headerActionsProps = {
    docId: docId!,
    versions,
    currentVersionNumber,
    isViewingLatest,
    onAddVersion: canEdit && !readMostly ? () => setShowAddVersion(true) : undefined,
    isUploader,
    onShare: () => setShowShare(true),
    onOpenFullScreen: openFullScreen,
    onDownloadHtml: downloadHtml,
    onCopyComments: copyComments,
    onExportComments: exportComments,
    onDelete: async () => {
      await deleteDoc.mutateAsync();
      navigate('/');
    },
  };
```

Notes for the implementer:
- The old inner cluster (folder control + version selector + Share + ⋯ menu + confirm + feedback popovers, lines 563–701) is fully replaced by `DocDetailFolderControl` + `<HeaderActions variant="desktop">`; delete the leftover JSX including the temporary `share:` entry added in Task 5.
- The Move-to-folder control intentionally does not render below `md` (accepted cut per spec).
- Title clamp: `line-clamp-2` sets `display: -webkit-box`; no competing display utility remains in the base layer. `md:line-clamp-none` sets `display: block` at `md`+, which is what a flex item computes to anyway (the span sits inside EditableField's `inline-flex` wrapper), so desktop rendering is unchanged.
- Description: `inline-block` and `align-top` are removed outright — as a flex item the span was block-ified regardless, so desktop is unchanged; on mobile their absence lets the clamp's `-webkit-box` display win. This is the actual fix for the dead CSS shipped in #70.

- [ ] **Step 3: Typecheck and run the full web suite**

Run: `pnpm -C apps/web typecheck && pnpm -C apps/web test`
Expected: clean; all tests pass. Also confirm the dead code is gone: `grep -n "actionsMenuState\|copyFeedback\|showFeedback" apps/web/src/routes/document.tsx` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/document.tsx
git commit -m "fix(web): compact mobile document header with working clamps

Refs: #71"
```

---

### Task 8: Full verification, draft PR, issue bookkeeping

**Files:** none (verification + GitHub workflow)

- [ ] **Step 1: Full verification**

```bash
pnpm -C packages/shared typecheck
pnpm -C apps/api typecheck && pnpm -C apps/api test
pnpm -C apps/web typecheck && pnpm -C apps/web test
pnpm -C apps/web build
```
Expected: all clean/green (API 636 + 6 new; web 195 + ~16 new). Sanity-check the clamp fix in source: `grep -n "line-clamp-2" apps/web/src/routes/document.tsx` must show both clamped fields and neither line may also contain `inline-block` (Task 7 Step 3 already verified the dead-state cleanup).

- [ ] **Step 2: STOP — get the user's push greenlight**

Per Global Constraints, do not push. Present the summary and ask for the greenlight to push the branch and open the draft PR.

- [ ] **Step 3 (after greenlight): push + draft PR + labels + issue comment**

```bash
git push -u origin issue-71-mobile-document-view
gh pr create --draft \
  --title "fix(web): compact mobile header + fit-to-width artifacts" \
  --body "Closes #71. <summary of the seven commits + the verification notes below>"
gh issue edit 71 --remove-label in-progress --add-label needs-review
gh issue comment 71 --body "<same verification notes>"
```

PR body must end with the standard footer (🤖 Generated with [Claude Code](https://claude.com/claude-code) + session link).

Verification notes to include in both the PR body and the issue comment, for the reviewer's phone:
1. Header: title full-width and clamped to 2 lines, description clamped to 2 lines, breadcrumb + version selector + ⋯ on one compact row, Share reachable via ⋯, no dead space; artifact area visibly taller.
2. A wide artifact (e.g. one with a fixed-width table) renders fit-to-width with no horizontal page scroll; a normal artifact renders 1:1.
3. Desktop (`md`+) header and artifact look unchanged.
4. Pick-mode commenting from the bottom sheet still lands on the right element inside a scaled artifact.
5. Caveat: the companion is cached up to 1h (`cache-control: max-age=3600`), so a previously-visited artifact may need a hard refresh before fit-to-width engages.
