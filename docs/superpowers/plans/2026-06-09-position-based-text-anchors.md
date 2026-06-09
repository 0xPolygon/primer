# Position-Based Text-Range Anchors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-pattern matching used to anchor comments (prefix / selectorText / suffix / containerPath) with W3C-style TextPositionSelector — two raw character offsets into a flattened text walk of `document.body` — so every selection maps to a unique location in the immutable per-version artifact HTML.

**Architecture:** Build a cached "segment index" of all text nodes in the artifact iframe (excluding companion-managed DOM). Each segment records its `node`, `start`, and `end` as cumulative raw-character offsets. Capture walks `range.startContainer/offset` → `start` and `range.endContainer/offset` → `end`. Resolution walks `start` → `(textNode, offset)` and `end` → `(textNode, offset)`. Cross-cell, cross-paragraph, repeated-text, and whitespace edge cases all dissolve: the offsets are unique by construction. Per-version artifacts are immutable in storage, so offsets are stable across reloads and versions.

**Backward compat:** Existing anchors stored under the legacy `{ prefix, selectorText, suffix, containerPath }` shape keep resolving via the existing matcher. New captures use the new shape. The validator and resolver dispatch on which fields are present. No DB migration required.

**Tech Stack:** Plain ES2020 (`apps/api/src/companion/v1.js` is served verbatim into the sandbox iframe), TypeScript for shared protocol types and tests, Vitest for unit tests.

---

## File Structure

**Touched files:**

- **Modify** `apps/api/src/companion/v1.js` — add segment index, replace capture and resolution math, dispatch on anchor shape for backward compat.
- **Modify** `packages/shared/src/companion-protocol.ts` — extend `TextRangeAnchor` with optional `start`/`end`; make legacy fields optional; update `isTextRangeAnchor` validator to accept either shape.
- **Create** `apps/api/src/companion/textRangePosition.test.ts` — pure-logic tests + helpers mirroring the new index/offset math (parallel to the existing `textRangeResolution.test.ts` which stays in place for the legacy path).
- **Modify** `apps/api/src/companion/textRangeResolution.test.ts` — add a comment at the top noting it covers the legacy fallback path only (no behavior change).
- **Modify** `apps/web/src/routes/devHarness.tsx` — add a tiny fixture button that loads the user's `bpn-production-configuration-v1.html` (or an inline equivalent containing tables) so cross-cell can be exercised manually.

**Untouched (verified):**

- `apps/web/src/components/{ThreadCard,NewThreadComposer,CommentSidebar}.tsx` — consume only `anchor.selectorText` for display, which we keep emitting.
- `apps/web/src/lib/exportComments.ts` — same. (Verify with grep in Task 6.)
- `apps/api/src/routes/comments.ts` — stores/returns anchor JSON opaquely. No change.

---

## Conventions in This Plan

- **Raw offsets, not normalized.** Artifacts are immutable per version → no whitespace re-normalization needed. Walk text nodes, sum `nodeValue.length`.
- **Skip companion DOM.** Filter the TreeWalker to reject text nodes whose ancestor has `id ∈ { __primer_overlay__, __primer_pick_banner__, __primer_companion_style__ }`. Otherwise our own injected badges would corrupt offsets.
- **Cache the segment index lazily.** Build on first need. Never invalidate — the only DOM mutations are our own filtered nodes.
- **Endpoint normalization on capture.** If `range.startContainer` is an Element (rare but possible — selection anchored at element boundary), descend into `childNodes[range.startOffset]` and walk to the first text descendant. Symmetric for the end endpoint, walking to the last text descendant. This keeps the offset math text-node-only.
- **Boundary convention.** An offset that equals `segment.end` of segment N (== `segment.start` of segment N+1) resolves to segment N's end. Document this in a code comment so future-you doesn't flip it.

---

## Task 1: Set up new test file with failing cross-cell test

**Files:**
- Create: `apps/api/src/companion/textRangePosition.test.ts`

- [ ] **Step 1: Create the test file with pure-logic types and a failing cross-cell test**

```typescript
// apps/api/src/companion/textRangePosition.test.ts
//
// Pure-logic tests for the position-based text-range anchor in v1.js.
// The companion script is plain ES2020 served verbatim into the iframe,
// so the helpers below are a self-contained mirror of the math. If you
// change the math in v1.js, mirror it here (and vice versa).
//
// These tests do NOT exercise DOM — they operate on a synthetic
// `Segment[]` representation that mimics what `computeSegments(root)`
// returns. DOM integration is verified manually via devHarness.

import { describe, it, expect } from 'vitest';

// ── Types ────────────────────────────────────────────────────────────

/** One text-node entry in the segment index. `start` is inclusive,
 *  `end` is exclusive, both in raw cumulative characters from
 *  document.body. */
interface Segment {
  id: string;        // synthetic test ID; real impl uses the Text node ref
  text: string;
  start: number;
  end: number;
}

/** A range endpoint in the test fixture: which segment and the offset
 *  within that segment's text. */
interface Endpoint {
  segId: string;
  offset: number;
}

// ── Helpers (mirror of v1.js — keep in sync) ─────────────────────────

/** Build a segment index from a list of text-node values. Returns the
 *  Segment[] with cumulative start/end offsets. */
function buildSegments(textsById: Array<{ id: string; text: string }>): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const { id, text } of textsById) {
    out.push({ id, text, start: cursor, end: cursor + text.length });
    cursor += text.length;
  }
  return out;
}

/** Map an endpoint (segment + intra-segment offset) → raw cumulative offset. */
function endpointToOffset(segs: Segment[], ep: Endpoint): number {
  const seg = segs.find((s) => s.id === ep.segId);
  if (!seg) throw new Error(`segment not found: ${ep.segId}`);
  if (ep.offset < 0 || ep.offset > seg.text.length) {
    throw new Error(`offset ${ep.offset} out of range for segment ${ep.segId}`);
  }
  return seg.start + ep.offset;
}

/** Map a raw cumulative offset → endpoint. Offsets at segment boundaries
 *  resolve to the END of the earlier segment (not the start of the next).
 *  Returns null if offset is out of bounds. */
function offsetToEndpoint(segs: Segment[], offset: number): Endpoint | null {
  if (segs.length === 0) return null;
  const last = segs[segs.length - 1]!;
  if (offset < 0 || offset > last.end) return null;
  // Binary search for the segment whose [start, end] contains offset.
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segs[mid]!;
    if (offset < seg.start) hi = mid - 1;
    else if (offset > seg.end) lo = mid + 1;
    else {
      // Boundary convention: if offset == seg.end and there's a next
      // segment, still return this segment (not the next's start).
      return { segId: seg.id, offset: offset - seg.start };
    }
  }
  return null;
}

/** Reconstruct the text between two raw offsets by walking segments. */
function sliceByOffsets(segs: Segment[], start: number, end: number): string {
  let out = '';
  for (const seg of segs) {
    if (seg.end <= start) continue;
    if (seg.start >= end) break;
    const a = Math.max(0, start - seg.start);
    const b = Math.min(seg.text.length, end - seg.start);
    out += seg.text.slice(a, b);
  }
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('position-based anchors — cross-cell selection', () => {
  it('round-trips a selection that spans three table cells', () => {
    // Mimics: <tr><td>usdc_ethereum</td><td>COINME</td><td>USDC</td></tr>
    // Real HTML may have whitespace text nodes between cells (varies by
    // HTML5 parser rules — but per spec, whitespace inside a TR between
    // TD elements is dropped). We model the dense case here; the
    // sparse-whitespace variant is covered in a separate test below.
    const segs = buildSegments([
      { id: 'td1', text: 'usdc_ethereum' },
      { id: 'td2', text: 'COINME' },
      { id: 'td3', text: 'USDC' },
    ]);

    // Select from "usdc_ethereum" (start of td1) to mid-"USDC" (offset 4 of td3, i.e. all of "USDC").
    const start = endpointToOffset(segs, { segId: 'td1', offset: 0 });
    const end = endpointToOffset(segs, { segId: 'td3', offset: 4 });

    expect(start).toBe(0);
    expect(end).toBe(13 + 6 + 4); // 23

    // Resolve back.
    const startEp = offsetToEndpoint(segs, start);
    const endEp = offsetToEndpoint(segs, end);
    expect(startEp).toEqual({ segId: 'td1', offset: 0 });
    expect(endEp).toEqual({ segId: 'td3', offset: 4 });

    // And the selected text is the concatenation across cells.
    expect(sliceByOffsets(segs, start, end)).toBe('usdc_ethereumCOINMEUSDC');
  });
});
```

- [ ] **Step 2: Run the new test to confirm the harness works**

Run: `cd apps/api && pnpm vitest run src/companion/textRangePosition.test.ts`

Expected: PASS (the helpers in the file ARE the implementation under test in this file — the real integration happens in Task 5/6 when v1.js is wired up. This file's job is to lock the math down so v1.js can mirror it.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/textRangePosition.test.ts
git commit -m "test(commenting): scaffold position-based anchor test file with cross-cell round-trip"
```

---

## Task 2: Add same-block + cross-paragraph + boundary tests

**Files:**
- Modify: `apps/api/src/companion/textRangePosition.test.ts`

- [ ] **Step 1: Append additional describe blocks**

Append to `apps/api/src/companion/textRangePosition.test.ts`:

```typescript
describe('position-based anchors — single-block selections', () => {
  it('round-trips a selection inside a single text node', () => {
    const segs = buildSegments([
      { id: 'p1', text: 'Hello World friend' },
    ]);
    const start = endpointToOffset(segs, { segId: 'p1', offset: 6 });
    const end = endpointToOffset(segs, { segId: 'p1', offset: 11 });
    expect(sliceByOffsets(segs, start, end)).toBe('World');
    expect(offsetToEndpoint(segs, start)).toEqual({ segId: 'p1', offset: 6 });
    expect(offsetToEndpoint(segs, end)).toEqual({ segId: 'p1', offset: 11 });
  });

  it('round-trips a selection that includes a nested element boundary', () => {
    // <p>Hello <em>brave</em> world</p>
    // → three text nodes: "Hello ", "brave", " world"
    const segs = buildSegments([
      { id: 't1', text: 'Hello ' },
      { id: 't2', text: 'brave' },
      { id: 't3', text: ' world' },
    ]);
    // Select "brave world" (offset 0 of t2 through offset 6 of t3).
    const start = endpointToOffset(segs, { segId: 't2', offset: 0 });
    const end = endpointToOffset(segs, { segId: 't3', offset: 6 });
    expect(sliceByOffsets(segs, start, end)).toBe('brave world');
  });
});

describe('position-based anchors — cross-paragraph selection', () => {
  it('round-trips a selection that crosses a P→P boundary', () => {
    // <article><p>First paragraph.</p>\n<p>Second paragraph.</p></article>
    // The whitespace between </p> and <p> in flow-content IS a text node.
    const segs = buildSegments([
      { id: 'p1', text: 'First paragraph.' },
      { id: 'ws', text: '\n' },
      { id: 'p2', text: 'Second paragraph.' },
    ]);
    // Select "paragraph.\nSecond" (from "paragraph." in p1 to "Second" in p2).
    const start = endpointToOffset(segs, { segId: 'p1', offset: 6 });
    const end = endpointToOffset(segs, { segId: 'p2', offset: 6 });
    expect(sliceByOffsets(segs, start, end)).toBe('paragraph.\nSecond');
    expect(offsetToEndpoint(segs, start)).toEqual({ segId: 'p1', offset: 6 });
    expect(offsetToEndpoint(segs, end)).toEqual({ segId: 'p2', offset: 6 });
  });
});

describe('position-based anchors — boundary cases', () => {
  it('resolves offset 0 to the first segment, offset 0', () => {
    const segs = buildSegments([
      { id: 'a', text: 'Hello' },
      { id: 'b', text: 'World' },
    ]);
    expect(offsetToEndpoint(segs, 0)).toEqual({ segId: 'a', offset: 0 });
  });

  it('resolves the total length to the last segment, end of its text', () => {
    const segs = buildSegments([
      { id: 'a', text: 'Hello' },
      { id: 'b', text: 'World' },
    ]);
    expect(offsetToEndpoint(segs, 10)).toEqual({ segId: 'b', offset: 5 });
  });

  it('resolves an offset that sits exactly on a segment boundary to the earlier segment', () => {
    // Locks the boundary convention: end of "Hello" (offset 5) belongs
    // to segment 'a', not the start of 'b'. Symmetric to how Range.setEnd
    // works when endOffset equals the end of a text node.
    const segs = buildSegments([
      { id: 'a', text: 'Hello' },
      { id: 'b', text: 'World' },
    ]);
    expect(offsetToEndpoint(segs, 5)).toEqual({ segId: 'a', offset: 5 });
  });

  it('returns null for out-of-bounds offsets', () => {
    const segs = buildSegments([{ id: 'a', text: 'Hello' }]);
    expect(offsetToEndpoint(segs, -1)).toBeNull();
    expect(offsetToEndpoint(segs, 6)).toBeNull();
  });

  it('handles empty text nodes without producing nonsense endpoints', () => {
    // Empty text nodes can be created by the HTML parser in edge cases.
    // Their start == end. They should never be selected by binary search
    // for any offset because no offset's range [start, end) includes them.
    const segs = buildSegments([
      { id: 'a', text: 'Hello' },
      { id: 'empty', text: '' },
      { id: 'b', text: 'World' },
    ]);
    // Offset 5 is the boundary. Earlier-segment convention picks 'a' (not
    // 'empty' or 'b'). This is what we want — never produce an endpoint
    // inside an empty segment.
    expect(offsetToEndpoint(segs, 5)).toEqual({ segId: 'a', offset: 5 });
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `cd apps/api && pnpm vitest run src/companion/textRangePosition.test.ts`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/textRangePosition.test.ts
git commit -m "test(commenting): cover single-block, cross-paragraph, and boundary cases for position anchors"
```

---

## Task 3: Add segment index + offset math to v1.js (capture-side only)

**Files:**
- Modify: `apps/api/src/companion/v1.js`

This task wires the helpers into v1.js but does NOT yet switch the capture or resolve paths. We just add the new functions next to the existing ones, behind a feature-isolated section. Capture/resolve switchover is in Task 4 and 5 so the diff stays reviewable.

- [ ] **Step 1: Insert the segment-index helpers after the "Pure helpers" block**

In `apps/api/src/companion/v1.js`, find the comment `// ── Pure helpers used across capture / rendering ─────────────────` (around line 263 in current code). After the `cssPath` function and `collectContext` function (around line 354), insert a new section:

```javascript
  // ── Position-based anchoring (W3C TextPositionSelector style) ────
  //
  // Artifacts are immutable per version, so we anchor text-range
  // comments by raw cumulative character offsets into the flattened
  // text walk of document.body. Capture: range endpoints → (start, end)
  // integers. Resolve: (start, end) → DOM Range. Cross-block,
  // cross-cell, repeated-text, and whitespace edge cases dissolve.

  /** Ids of DOM injected by the companion. Text nodes inside any of
   *  these subtrees are excluded from the segment index so our own
   *  badges / banner do not shift offsets. */
  const COMPANION_DOM_IDS = new Set([
    '__primer_overlay__',
    '__primer_pick_banner__',
    '__primer_companion_style__',
  ]);

  /** Cached segment index. Built lazily on first call to getSegments().
   *  Never invalidated: artifact DOM is immutable, companion DOM is
   *  excluded from the walk, so the index is stable for the lifetime
   *  of the iframe. */
  /** @type {{ node: Text, start: number, end: number }[] | null} */
  let _segmentsCache = null;

  function getSegments() {
    if (_segmentsCache) return _segmentsCache;
    /** @type {{ node: Text, start: number, end: number }[]} */
    const out = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          let p = node.parentElement;
          while (p) {
            if (p.id && COMPANION_DOM_IDS.has(p.id)) {
              return NodeFilter.FILTER_REJECT;
            }
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let cursor = 0;
    let n = walker.nextNode();
    while (n) {
      const t = /** @type {Text} */ (n);
      const len = t.nodeValue ? t.nodeValue.length : 0;
      out.push({ node: t, start: cursor, end: cursor + len });
      cursor += len;
      n = walker.nextNode();
    }
    _segmentsCache = out;
    return out;
  }

  /** Map (containerNode, intra-node offset) → raw cumulative offset.
   *  If containerNode is an Element, descends into childNodes[offset]
   *  and walks to the first text descendant (which == "position at start
   *  of that subtree's text"). Returns -1 if no mapping found. */
  function endpointToOffset(containerNode, offset) {
    if (containerNode instanceof Text) {
      const segs = getSegments();
      for (const seg of segs) {
        if (seg.node === containerNode) {
          // Clamp to segment bounds defensively.
          const clamped = Math.max(0, Math.min(offset, seg.end - seg.start));
          return seg.start + clamped;
        }
      }
      return -1;
    }
    // Element case: the offset is an index into containerNode.childNodes.
    // Find the child node at that position; if past the last child, use
    // "end of element's last text descendant"; otherwise use "start of
    // child's first text descendant".
    if (!(containerNode instanceof Element)) return -1;
    const children = containerNode.childNodes;
    if (offset >= children.length) {
      // Past last child: end of element. Find last text descendant
      // and return its end.
      const lastText = findLastTextDescendant(containerNode);
      if (!lastText) return -1;
      const segs = getSegments();
      for (const seg of segs) {
        if (seg.node === lastText) return seg.end;
      }
      return -1;
    }
    const child = children[offset];
    const firstText = child instanceof Text ? child : findFirstTextDescendant(child);
    if (!firstText) return -1;
    const segs = getSegments();
    for (const seg of segs) {
      if (seg.node === firstText) return seg.start;
    }
    return -1;
  }

  function findFirstTextDescendant(node) {
    if (node instanceof Text) return node;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    return /** @type {Text | null} */ (walker.nextNode());
  }

  function findLastTextDescendant(node) {
    if (node instanceof Text) return node;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    /** @type {Text | null} */
    let last = null;
    /** @type {Node | null} */
    let n = walker.nextNode();
    while (n) {
      last = /** @type {Text} */ (n);
      n = walker.nextNode();
    }
    return last;
  }

  /** Map a raw cumulative offset → (Text node, intra-node offset).
   *  Boundary convention: an offset equal to seg.end resolves to that
   *  segment's end (not the next segment's start) — matches how
   *  Range.setEnd treats endOffset == text.length.
   *  Returns null if out of bounds or segments are empty. */
  function offsetToEndpoint(rawOffset) {
    const segs = getSegments();
    if (segs.length === 0) return null;
    const last = segs[segs.length - 1];
    if (rawOffset < 0 || rawOffset > last.end) return null;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid];
      if (rawOffset < seg.start) hi = mid - 1;
      else if (rawOffset > seg.end) lo = mid + 1;
      else return { node: seg.node, offset: rawOffset - seg.start };
    }
    return null;
  }

  /** Build a DOM Range from raw (start, end) offsets. Returns null if
   *  either endpoint can't be mapped or end < start. */
  function rangeFromOffsets(start, end) {
    if (end < start) return null;
    const a = offsetToEndpoint(start);
    const b = offsetToEndpoint(end);
    if (!a || !b) return null;
    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 2: Manual smoke — confirm the file still parses**

Run: `cd apps/api && pnpm tsc --noEmit -p tsconfig.json` (if v1.js is checked) OR `node --check apps/api/src/companion/v1.js`.

Expected: No syntax errors. (v1.js is plain JS, the project may or may not type-check it via JSDoc.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(commenting): add segment index + offset helpers to companion"
```

---

## Task 4: Switch capture to emit position-based anchors

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Replace the anchor construction in `onPossibleSelection`**

In `apps/api/src/companion/v1.js`, find `function onPossibleSelection()` (around line 361). Replace the body of the function from the `const range = sel.getRangeAt(0);` line through the end of the function. The new body uses the new offset helpers and emits the new anchor shape, dropping `prefix`/`suffix`/`containerPath`.

Find this block:

```javascript
  function onPossibleSelection() {
    if (!port) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const selectorText = sel.toString();
    if (selectorText.trim().length === 0) return;

    const container = nearestBlockAncestor(range.startContainer);
    const { prefix, suffix } = collectContext(container, range, 32);
    const containerPath = cssPath(container);

    const fingerprint = `${containerPath}|${prefix}|${selectorText}|${suffix}`;
    if (fingerprint === lastEmittedFingerprint && Date.now() - lastEmittedAt < 200) {
      return;
    }
    lastEmittedFingerprint = fingerprint;
    lastEmittedAt = Date.now();

    const clientRects = Array.from(range.getClientRects()).map(serializeRect);

    port.postMessage({
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText,
        prefix,
        suffix,
        containerPath,
      },
      clientRects,
    });
  }
```

Replace it with:

```javascript
  function onPossibleSelection() {
    if (!port) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const selectorText = sel.toString();
    if (selectorText.trim().length === 0) return;

    // Reject selections that started inside companion DOM (e.g., the
    // user dragged across our overlay badges). endpointToOffset would
    // return -1 anyway, but bailing here keeps the capture path quiet.
    if (
      isInCompanionDom(range.startContainer) ||
      isInCompanionDom(range.endContainer)
    ) {
      return;
    }

    const start = endpointToOffset(range.startContainer, range.startOffset);
    const end = endpointToOffset(range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) {
      log.warn('selection capture skipped — endpoints unmappable', { start, end });
      return;
    }

    const fingerprint = `${start}|${end}`;
    if (fingerprint === lastEmittedFingerprint && Date.now() - lastEmittedAt < 200) {
      return;
    }
    lastEmittedFingerprint = fingerprint;
    lastEmittedAt = Date.now();

    const clientRects = Array.from(range.getClientRects()).map(serializeRect);

    port.postMessage({
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        start,
        end,
        selectorText,
      },
      clientRects,
    });
  }

  function isInCompanionDom(node) {
    let p = node instanceof Element ? node : node.parentElement;
    while (p) {
      if (p.id && COMPANION_DOM_IDS.has(p.id)) return true;
      p = p.parentElement;
    }
    return false;
  }
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check apps/api/src/companion/v1.js`

Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(commenting): emit position-based anchors from selection capture"
```

---

## Task 5: Switch resolution to dispatch on anchor shape

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add a dispatching wrapper around the existing text-range resolver**

In `apps/api/src/companion/v1.js`, find `function resolveTextRange(anchor)` (around line 475). Rename the existing function to `resolveTextRangeLegacy` (keeps the prefix/suffix/containerPath path intact for old anchors). Then add a new top-level dispatcher.

Change the declaration line of the existing function:

```javascript
  function resolveTextRange(anchor) {
```

To:

```javascript
  function resolveTextRangeLegacy(anchor) {
```

(Leave the body of `resolveTextRangeLegacy` exactly as it is.)

Then immediately above the `resolveTextRangeLegacy` declaration, add the new dispatcher:

```javascript
  /** Resolve a text-range anchor to a DOM Range. Dispatches on shape:
   *  position-based anchors (start/end integers) use the segment index;
   *  legacy anchors (prefix/selectorText/suffix/containerPath) use the
   *  text-pattern matcher. Returns null if unresolvable. */
  function resolveTextRange(anchor) {
    if (
      typeof anchor.start === 'number' &&
      typeof anchor.end === 'number' &&
      Number.isFinite(anchor.start) &&
      Number.isFinite(anchor.end)
    ) {
      return rangeFromOffsets(anchor.start, anchor.end);
    }
    if (typeof anchor.containerPath === 'string') {
      return resolveTextRangeLegacy(anchor);
    }
    return null;
  }
```

- [ ] **Step 2: Verify the file still parses**

Run: `node --check apps/api/src/companion/v1.js`

Expected: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(commenting): dispatch text-range resolution on anchor shape"
```

---

## Task 6: Update shared protocol types and validator

**Files:**
- Modify: `packages/shared/src/companion-protocol.ts`
- Modify: `apps/web/src/companion/protocol.test.ts` (already has parseInboundMessage tests — extend with new-shape coverage)

- [ ] **Step 1: Update the `TextRangeAnchor` interface and validator**

In `packages/shared/src/companion-protocol.ts`, replace:

```typescript
export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  prefix: string;
  suffix: string;
  containerPath: string;
}
```

with:

```typescript
/** Text-range anchor. New captures (v1.1+) emit `start`/`end` raw
 *  character offsets into the artifact's flattened text. Legacy
 *  captures (pre-v1.1) carry `prefix`/`suffix`/`containerPath` for
 *  text-pattern resolution. The companion's resolver dispatches on
 *  which fields are present, so both shapes are valid on the wire and
 *  in storage. New code should write the position-based shape. */
export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  /** Inclusive raw cumulative character offset (position-based shape). */
  start?: number;
  /** Exclusive raw cumulative character offset (position-based shape). */
  end?: number;
  /** Legacy: text-context prefix. Present on pre-v1.1 anchors. */
  prefix?: string;
  /** Legacy: text-context suffix. Present on pre-v1.1 anchors. */
  suffix?: string;
  /** Legacy: CSS path to the nearest block ancestor. Present on
   *  pre-v1.1 anchors. */
  containerPath?: string;
}
```

And replace:

```typescript
export function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
  return (
    isObject(v) &&
    v.type === 'text-range' &&
    isString(v.selectorText) &&
    isString(v.prefix) &&
    isString(v.suffix) &&
    isString(v.containerPath)
  );
}
```

with:

```typescript
export function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
  if (!isObject(v) || v.type !== 'text-range' || !isString(v.selectorText)) {
    return false;
  }
  // Position-based shape: start AND end must be finite numbers.
  const hasPosition = isNumber(v.start) && isNumber(v.end);
  // Legacy shape: prefix AND suffix AND containerPath must all be strings.
  const hasLegacy =
    isString(v.prefix) && isString(v.suffix) && isString(v.containerPath);
  return hasPosition || hasLegacy;
}
```

- [ ] **Step 2: Extend `parseInboundMessage` coverage in protocol.test.ts**

Open `apps/web/src/companion/protocol.test.ts`, find the `selection_captured` describe block, and add the following test cases (adapt to the file's existing test style; the snippets below assume Vitest + the existing import of `parseInboundMessage`):

```typescript
  it('accepts selection_captured with position-based anchor', () => {
    const parsed = parseInboundMessage({
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        start: 100,
        end: 111,
      },
      clientRects: [{ x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('selection_captured');
  });

  it('accepts selection_captured with legacy text-context anchor', () => {
    const parsed = parseInboundMessage({
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        prefix: 'before ',
        suffix: ' after',
        containerPath: 'body > article > p',
      },
      clientRects: [],
    });
    expect(parsed).not.toBeNull();
  });

  it('rejects text-range anchor missing both shapes', () => {
    const parsed = parseInboundMessage({
      type: 'selection_captured',
      anchor: { type: 'text-range', selectorText: 'just text' },
      clientRects: [],
    });
    expect(parsed).toBeNull();
  });

  it('rejects text-range anchor with partial position shape (start only)', () => {
    const parsed = parseInboundMessage({
      type: 'selection_captured',
      anchor: { type: 'text-range', selectorText: 'x', start: 5 },
      clientRects: [],
    });
    expect(parsed).toBeNull();
  });
```

- [ ] **Step 3: Run shared + web tests**

Run from repo root:

```bash
pnpm --filter @primer/shared test
pnpm --filter @primer/web test apps/web/src/companion/protocol.test.ts
```

Expected: All tests PASS, including the four new cases.

- [ ] **Step 4: Sanity-grep consumers to confirm only `selectorText` is read**

Run from repo root:

```bash
grep -rn "anchor\.prefix\|anchor\.suffix\|anchor\.containerPath\|\.prefix\s*=" apps/web/src
```

Expected: No matches in component code (only the test file you just edited and the protocol types). If any UI/business-logic file destructures the legacy fields, those are stale code paths — flag in PR description and decide whether to delete in a follow-up; do NOT bundle the cleanup into this PR.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/companion-protocol.ts apps/web/src/companion/protocol.test.ts
git commit -m "feat(commenting): accept position-based anchor shape in protocol validator"
```

---

## Task 7: Add cross-cell fixture to devHarness for manual verification

**Files:**
- Modify: `apps/web/src/routes/devHarness.tsx`

The memory entry "Substrate verification in real flow" requires verifying changes in the user-facing flow, not just unit tests. This task adds a thin verification surface so cross-cell anchoring can be exercised end-to-end (capture → store → reload → resolve → highlight) without spinning up the full upload pipeline.

- [ ] **Step 1: Identify where the harness loads its iframe source**

Read `apps/web/src/routes/devHarness.tsx` (the first ~60 lines were already read; read the rest to find where the iframe `src` is set — typically a hard-coded artifact URL or a state-controlled input).

- [ ] **Step 2: Add a "Cross-cell fixture" option**

Inside the dev harness UI (a `<select>` or a button row, whichever pattern is in use), add an option that loads an inline data-URI containing a minimal table HTML:

```typescript
const CROSS_CELL_FIXTURE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><script src="/companion/v1.js" defer></script></head>
<body><article>
  <h2>Cross-cell fixture</h2>
  <table>
    <thead><tr><th>pair_code</th><th>vendor</th><th>asset</th></tr></thead>
    <tbody>
      <tr><td>usdc_ethereum</td><td>COINME</td><td>USDC</td></tr>
      <tr><td>usdc_polygon</td><td>COINME</td><td>USDC</td></tr>
    </tbody>
  </table>
  <p>First paragraph for cross-paragraph test.</p>
  <p>Second paragraph for cross-paragraph test.</p>
</article></body></html>
`)}`;
```

Wire it as a selectable fixture in whatever fixture-picker pattern the harness already uses. If the harness has no fixture picker, add a "Load cross-cell fixture" button that sets the iframe src to `CROSS_CELL_FIXTURE`.

Note: the iframe sandbox in production blocks data: URIs from running scripts in some configurations. If the harness's sandbox attribute prevents `data:` script execution, host the fixture as a static file under `apps/web/public/fixtures/cross-cell.html` instead and reference it by URL. Check the harness's existing iframe element to determine which path to take. Either path is acceptable as long as the companion script runs.

- [ ] **Step 3: Manual verification flow**

Run the dev server (per repo conventions; this project uses Hono + Vite — see top-level `package.json` for the dev script). With the dev harness open:

  1. Load the cross-cell fixture.
  2. In the iframe, select text starting in the first `<td>` of row 1 and ending in the third `<td>` of row 1 — i.e. `usdc_ethereum...USDC`.
  3. In the harness UI, observe the `selection_captured` log entry. Confirm the anchor payload has `start` and `end` integers and DOES NOT have `prefix`/`suffix`/`containerPath`.
  4. Click "Promote pending selection to anchor" (the harness has a button for this — its exact name may vary, but it sends the captured anchor back as part of `update_anchors`).
  5. Confirm the highlight appears in the iframe spanning the three cells.
  6. Reload the iframe (the harness usually has a reload button). After reload, the harness re-sends the same anchor via `init`. Confirm the highlight reappears in the same place.
  7. Repeat steps 2–6 for a cross-paragraph selection (P1 → P2) to confirm the same path works.
  8. Repeat for a same-block selection (a single word in one P) to confirm no regression.

- [ ] **Step 4: Document the manual result**

Add a short note to the PR description (or a comment in the commit message) recording: "Verified manually in devHarness: cross-cell, cross-paragraph, and same-block selections all round-trip across iframe reload."

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/devHarness.tsx apps/web/public/fixtures/cross-cell.html
# (omit the second path if you used the data: URI variant)
git commit -m "test(commenting): add cross-cell fixture to devHarness"
```

---

## Task 8: Add a comment-suite regression check on the real document

**Files:**
- No new files. This is a manual end-to-end check against the user's actual document.

- [ ] **Step 1: Start the app per the project's normal dev flow**

The user's environment is NixOS; per the memory entry `NixOS PATH for pnpm postinstalls`, ensure both pnpm and Nix-store node are on PATH. Per `No wrangler dev locally`, do not use wrangler. Use the project's dev script (likely `pnpm dev` at repo root or `pnpm --filter @primer/api dev` + `pnpm --filter @primer/web dev`).

- [ ] **Step 2: Reproduce the original bug to confirm pre-fix state was real**

If a copy of the failing anchor still exists in the dev DB on an old document version, focus the comment in the sidebar — confirm it still appears "drifted" (legacy resolver behavior, expected and unchanged). If you don't have such an anchor, skip this step.

- [ ] **Step 3: End-to-end repro of the fix**

  1. Open the BPN configuration document (the user's `tmp/bpn-production-configuration-v1.html` — upload as a new version via the normal upload flow if it isn't already in dev).
  2. Select text spanning `usdc_ethereum` through `USDC` across the first three columns of row 1 in §1.2.
  3. Create a new comment thread on that selection.
  4. Submit the comment. Confirm the sidebar shows the thread anchored to the selected text.
  5. Hard-reload the page.
  6. Confirm the highlight reappears at the same location and the thread is still anchored (not drifted).
  7. Confirm the sidebar preview shows the selected cell text via `selectorText`.

- [ ] **Step 4: Cross-paragraph regression check on the same document**

Repeat step 3 with a selection that crosses two paragraphs in the document body (e.g., from a heading body into the next paragraph). Confirm it persists across reload.

- [ ] **Step 5: Same-block regression check**

Repeat with a double-click word selection inside a single paragraph. Confirm no regression vs. the prior version.

- [ ] **Step 6: Record findings**

If any check fails, return to Task 4/5 and use the systematic-debugging skill to locate the regression. If all pass, write a one-paragraph note in the PR description summarizing the manual verification (which document, which selections, what was observed).

- [ ] **Step 7: Per the memory `No auto-push without greenlight`, do NOT push to master.**

Wait for the user to explicitly say "push" before running `git push`. Master auto-deploys to Railway.

---

## Out of Scope (Follow-Up Plans)

These are deliberately deferred — call them out in the PR description so they're not forgotten:

1. **Backfill of legacy anchors.** A future CLI could load every existing `text-range` thread with the legacy shape, headless-render its version's HTML, run the legacy resolver, then rewrite the anchor in the position shape. Until then, legacy anchors continue resolving via the legacy path (works correctly for selections within a single block). A separate plan should design the CLI, including how to handle anchors that the legacy resolver can no longer resolve (i.e. already drifted — leave them drifted, don't fabricate offsets).

2. **Removing the legacy resolver after backfill.** Once all stored anchors are position-based, `resolveTextRangeLegacy`, `collectContext`, `cssPath`, `nearestBlockAncestor`, `BLOCK_TAGS`, and the legacy validator branch can be deleted in one cleanup PR.

3. **Dynamic-content artifacts.** If artifacts ever support scripts that mutate the DOM after load (currently they don't, per the immutability assumption), the segment-index cache becomes invalid. The plan for that would be a MutationObserver that invalidates `_segmentsCache` and re-resolves all anchors. Not needed today.

4. **Selection that touches non-text content only (e.g., images).** Currently captured as empty `selectorText` and rejected (`selectorText.trim().length === 0`). If we ever want image-anchored comments, design a separate anchor type — do not overload `text-range`.

---

## Self-Review

**Spec coverage:**
- Cross-cell selection works: Tasks 1, 2, 3, 4, 5, 7, 8.
- Cross-paragraph selection works: Tasks 2, 7, 8.
- Same-block selection unchanged: Tasks 2, 7, 8.
- Existing anchors keep resolving: Task 5 (dispatcher), Task 6 (validator accepts both shapes).
- Protocol types match the wire format: Task 6.
- Real-flow verification: Tasks 7 and 8.

**Placeholder scan:** No "TBD" / "implement later" / "appropriate error handling" / "similar to Task N" found.

**Type consistency:**
- `Segment` shape in test file uses `{ id, text, start, end }` — synthetic-test only; v1.js uses `{ node, start, end }` (real Text node ref instead of id). These differ deliberately because the test isolates the math from the DOM. Test file documents this in the file header comment.
- `endpointToOffset` / `offsetToEndpoint` names match between test file and v1.js.
- `TextRangeAnchor` field names (`start`, `end`, `selectorText`, `prefix`, `suffix`, `containerPath`) are consistent across `companion-protocol.ts`, v1.js capture, v1.js resolver, and the protocol tests.
- `COMPANION_DOM_IDS` is referenced by both `getSegments` and `isInCompanionDom`; defined once.
