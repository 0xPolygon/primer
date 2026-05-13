# Sub-project 2 — Anchoring + companion script: Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-05-13
**Status:** Approved for implementation planning
**Parent PRD:** `docs/prd-primer.md`
**Parent decomposition:** `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
**Predecessor:** `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md` (sub-project 1, already shipped)

## Purpose

Sub-project 2 builds the **substrate** for the comment system: the companion script (`/companion/v1.js` — currently a stub) gains its real body, and a parent↔iframe `postMessage` protocol carries selection capture, marker rendering, position resolution, pick mode, and external-link forwarding. No comment persistence, no sidebar, no thread storage — those land in sub-project 3, which will consume this substrate.

The exit gate is a dev-only test harness that exercises every protocol message end-to-end against a fixture artifact rendered through the real upload pipeline and served with the real artifact-endpoint security headers.

## Scope summary

**In scope:**

- Replace the stub `apps/api/src/companion/v1.js` with the full companion script implementing the PRD's five jobs (selection capture, element-pick capture, marker rendering, position resolution, external-nav forwarding).
- Parent↔iframe `postMessage` protocol, secured by a `MessageChannel` transferred at init time.
- Parent-side TypeScript wrapper around the protocol with full type safety on the message envelope.
- Shared protocol message types in `@primer/shared` so both halves can't drift on payload shapes.
- A dev-only Hono route serving a checked-in fixture artifact with the real artifact CSP.
- A dev-only `/dev/harness` React route that wires the fixture into `ArtifactIframe` and surfaces every protocol message in a debug pane.
- Vitest coverage for the parent-side wrapper (URL validation, message parser) and the Hono dev route (status, CSP).

**Out of scope (deferred to later sub-projects):**

- Storing anchors against `Thread` rows in the DB (sub-project 3).
- Floating "Add comment" affordance on selection, comment sidebar, `update_anchors` driven by real thread creation, 10-second polling (sub-project 3).
- Element-path resolution fallback when text-range resolution fails (sub-project 7). The element-path *capture* path is in scope here; the *resolve-with-fallback at render time* path is not.
- Form-submit interception (`<form target="_blank">`) — rare in LLM-generated artifacts, sandbox kills it silently already.
- Real auth on the dev routes — `NODE_ENV !== 'production'` registration gate is the v1 fence.
- Slack notifications, deep links (sub-project 6).
- Production deploy / Railway integration / observability.

## Stack notes

No new runtime dependencies. The companion script is hand-written browser JS, ~10-15 KB. Parent-side wrapper uses the existing TS/React/TanStack Query stack. `crypto.subtle.digest` is used for the element-path `innerHash` (browser-built-in).

The protocol message catalog and parser live in `packages/shared/src/companion-protocol.ts` — both apps import from there, so type drift between parent and (hand-written) companion is caught at TS typecheck time on the parent side and via the harness on the companion side.

## File map

```
apps/api/
  src/companion/
    v1.js                          # REPLACED — real companion (was stub)
    fixtures/
      anchoring.html               # NEW — checked-in fixture artifact (raw HTML)
  src/routes/
    devFixture.ts                  # NEW — Hono route: GET /dev/fixtures/anchoring.html
    devFixture.test.ts             # NEW — integration test for the dev route

packages/shared/
  src/companion-protocol.ts        # NEW — message types + parseInboundMessage
  src/companion-protocol.test.ts   # NEW — parser round-trip tests (lives in shared so both halves can import)

apps/web/
  src/components/
    ArtifactIframe.tsx             # MODIFIED — adds MessageChannel + props + onMessage callback
  src/companion/
    client.ts                      # NEW — parent-side protocol wrapper + URL validator
    client.test.ts                 # NEW — Vitest unit tests
  src/routes/
    devHarness.tsx                 # NEW — /dev/harness page
  src/App.tsx                      # MODIFIED — wires /dev/harness route
```

## Architecture overview

```
┌──────────────────────── Parent (apps/web) ───────────────────────┐
│                                                                   │
│  DocumentPage (existing)  /  DevHarnessPage (new)                 │
│        │                                                          │
│        └─ <ArtifactIframe                                         │
│               src=…                                               │
│               anchors={…}                                         │
│               onMessage={(msg) => …} />                           │
│              │                                                    │
│              ├─ on iframe.onload:                                 │
│              │     channel = new MessageChannel();                │
│              │     channel.port1.onmessage = handleInbound;       │
│              │     iframe.contentWindow.postMessage(              │
│              │       { type: 'init', anchors }, '*',              │
│              │       [channel.port2]                              │
│              │     );                                             │
│              └─ port1.postMessage(...) for all parent-side msgs   │
│                                                                   │
│        client.ts:                                                 │
│             isSafeExternalUrl(url) → boolean                      │
│             handleOpenExternal({ url }) → window.open(...)        │
│             ProtocolMessage / typed parser re-exports             │
└───────────────────────────────────────────────────────────────────┘
                              │
                       window.postMessage
                       (one time, port transfer)
                              │
┌──────────────────── Iframe (uploaded artifact) ──────────────────┐
│                                                                   │
│  Companion v1.js  (apps/api/src/companion/v1.js)                  │
│        │                                                          │
│        ├─ Install one-shot window 'message' listener              │
│        ├─ Wait for init event → port = event.ports[0]             │
│        ├─ Remove window listener; install port.onmessage          │
│        ├─ Prepend <style> for CSS highlights + badge styles       │
│        ├─ Insert overlay <div id="__primer_overlay__">            │
│        ├─ Wire ResizeObserver(document.body) → resize msg         │
│        ├─ Wire mouseup/keyup → selection_captured msg             │
│        ├─ Override window.open + click capture for external nav   │
│        └─ Resolve init.anchors → render markers                   │
└───────────────────────────────────────────────────────────────────┘
```

**Boot order guarantee:** parent waits for `iframe.onload` before sending init. The companion script is `defer` and injected before `</body>`, so by the time `load` fires, the companion has executed and its window-level `message` listener is registered. The init reliably reaches the companion.

**Security boundary:** the iframe runs under `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`, no `allow-popups`), set by `ArtifactIframe` in sub-project 1. The companion runs in opaque origin `null`. All cross-context communication flows through the transferred port; the parent never reaches into the iframe's DOM directly.

## Protocol message catalog

Defined in `packages/shared/src/companion-protocol.ts` as a discriminated union on `type`.

### Init / handshake

The init is the only `window.postMessage` call in the system; every subsequent message in either direction flows through the transferred port.

1. Parent awaits `iframe.onload`.
2. Parent creates `const channel = new MessageChannel()`.
3. Parent calls `iframe.contentWindow.postMessage({ type: 'init', anchors: Anchor[] }, '*', [channel.port2])`.
4. Companion's `window` 'message' listener catches the event, takes `event.ports[0]`, stashes it as `port`, sets `port.onmessage`, and removes the window-level listener (port is the only channel from now on).
5. Companion immediately runs `update_anchors`-equivalent logic using the init `anchors`.

If `init` does not arrive within 2 seconds, the companion gives up silently. The artifact continues to render as a static document; no annotation surface is available.

### Parent → Iframe

| Type | Payload | Meaning |
|---|---|---|
| `init` | `{ anchors: Anchor[] }` | One-time. Sent via `window.postMessage` w/ port transfer in `transferList`. |
| `update_anchors` | `{ anchors: Anchor[] }` | Replace the iframe's known anchor set wholesale. Triggers a marker re-render. |
| `enter_pick_mode` | `{}` | Companion enters pick mode (cursor change, hover outline, click trap). |
| `exit_pick_mode` | `{}` | Companion tears down pick mode. Parent-initiated. |
| `highlight_anchor` | `{ anchorId: string }` | Companion scrolls the anchor's range/element into view and switches it to the focused style for ~1.5s before reverting. |
| `request_anchor_positions` | `{}` | Companion responds with `anchor_positions`. |

### Iframe → Parent

| Type | Payload | Meaning |
|---|---|---|
| `selection_captured` | `{ anchor: TextRangeAnchor, clientRects: SerializableRect[] }` | Non-empty selection after mouseup/keyup. **No `id`** — the parent assigns one if and when it persists the anchor as a thread. |
| `element_picked` | `{ anchor: ElementPathAnchor, clientRect: SerializableRect }` | User clicked an element in pick mode. The companion auto-exits pick mode after emitting. |
| `pick_mode_exited` | `{}` | User pressed `Esc` while in pick mode. Parent reverts its toggle UI. |
| `anchor_positions` | `{ positions: { anchorId: string, rects: SerializableRect[], drifted?: boolean }[] }` | Response to `request_anchor_positions`. `drifted: true` when the anchor couldn't be resolved in the live DOM. |
| `resize` | `{ height: number }` | Companion's `ResizeObserver(document.body)` fired. Parent adjusts the iframe element's height. |
| `open_external` | `{ url: string }` | Parent validates `https:`, opens via `window.open(url, '_blank', 'noopener,noreferrer')`. Anything else is silently dropped (logged at warn level). |

### Additions to the PRD's message catalog

The PRD enumerates message types but doesn't claim exhaustiveness. Two additions are baked into this spec:

- **`update_anchors`** (parent→iframe). The PRD assumes the parent can push new anchors after init (so new comments show up without remounting the iframe), but doesn't name the message. Including now keeps the protocol stable for sub-project 3.
- **`pick_mode_exited`** (iframe→parent). The PRD doesn't mention how the user cancels pick mode without clicking. Esc inside the iframe needs to reach the parent so its pick-toggle UI can revert.

Neither addition expands the protocol's capabilities — they're flow-control messages, not new operations.

## Anchor format

```ts
export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  prefix: string;        // up to 32 chars before, whitespace-collapsed
  suffix: string;        // up to 32 chars after, whitespace-collapsed
  containerPath: string; // CSS path from <body> to nearest block-level ancestor
}

export interface ElementPathAnchor {
  type: 'element-path';
  path: string;          // CSS path from <body> using :nth-of-type(n) at each level
  innerHash: string;     // first 16 hex chars of SHA-256(element.textContent ?? '')
}

export interface Anchor {
  id: string;            // parent-controlled identifier (Thread.id in sub-project 3, synthetic in the harness)
  data: TextRangeAnchor | ElementPathAnchor;
}
```

**Whitespace normalization (load-bearing — capture and resolution MUST agree):**

```
normalize(s) = s.replace(/\s+/g, ' ').trim()
```

Both `prefix`/`suffix` extraction at capture time and the live-DOM string the resolution walk produces apply this same transform. Without identical normalization, captured anchors won't re-resolve.

**Block-level ancestor set** (for `containerPath` target):

`body, article, section, div, p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre, details`. Any other ancestor, keep walking up.

**CSS path format:**

`body > tagName:nth-of-type(n) > tagName:nth-of-type(n) > …`

`tagName` is lowercase. `:nth-of-type(n)` is 1-indexed among siblings of the same tag. For `<body>` itself, no `:nth-of-type` is appended.

Example: `body > div:nth-of-type(2) > section > svg > g:nth-of-type(3) > rect:nth-of-type(1)`.

## Marker rendering inside the iframe

### Text-range markers — CSS Custom Highlight API

The companion registers two named highlights in `CSS.highlights`:

- `primer-mark` — default appearance.
- `primer-mark-focused` — applied transiently when the parent sends `highlight_anchor`.

A single `<style>` element is prepended to `<head>` at companion init time:

```css
::highlight(primer-mark)         { background: rgba(254, 240, 138, 0.6); }
::highlight(primer-mark-focused) { background: rgba(252, 211, 77, 0.9); }
```

**Resolving a `TextRangeAnchor` to a `Range`:**

1. `document.querySelector(anchor.containerPath)` → block-level container element.
2. Walk descendant text nodes via `TreeWalker(NodeFilter.SHOW_TEXT)`, accumulating a flat string. As each text node's content is appended, record `(textNode, startOffsetInString, endOffsetInString)`.
3. Apply `normalize()` to the accumulated string AND to `prefix + selectorText + suffix`. Find the needle in the haystack.
4. Replay the offsets to find the `(textNode, offset)` start/end pairs that bracket `selectorText` within the matched window. Construct a `Range`.
5. Add `Range` to the `primer-mark` Highlight. The browser paints it via the `::highlight(primer-mark)` rule.

If step 3 fails (no match), mark the anchor as **drifted**. The companion remembers drifted anchors and returns `drifted: true` in the next `anchor_positions` response. No marker is rendered. (Element-path fallback at resolution time is sub-project 7 — out of scope here.)

**On `highlight_anchor(id)`:**

- Move the matched `Range` from `primer-mark` to `primer-mark-focused`; set a 1.5s timer to move it back.
- `range.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })`.

**On `update_anchors`:**

- Clear both Highlights' ranges. Rebuild from the new anchor list.

### Element-pick markers — overlay layer

The companion inserts an overlay layer once at load time. This is the only DOM mutation outside `<head>`:

```html
<div id="__primer_overlay__" style="
  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 2147483646;
"></div>
```

`pointer-events: none` means the overlay never steals clicks.

For each element-path anchor:

- Resolve `document.querySelector(anchor.path)` → element.
- Verify `sha256Hex(normalize(element.textContent ?? '')).slice(0, 16) === anchor.innerHash`. If not, mark drifted.
- On every relevant frame, compute `element.getBoundingClientRect()` and position a small absolutely-positioned `.__primer_badge__` div alongside the rect inside the overlay.

Badge styles (in the same prepended `<style>`):

```css
.__primer_badge__ {
  position: absolute;
  background: rgba(254, 240, 138, 0.95);
  border: 1px solid rgba(202, 138, 4, 0.6);
  border-radius: 9999px;
  padding: 0 6px;
  font: 11px/16px system-ui;
  pointer-events: none;
}
.__primer_badge__.focused {
  background: rgba(252, 211, 77, 1);
  outline: 2px solid rgba(202, 138, 4, 0.8);
}
```

**Position-update strategy:**

- One `ResizeObserver(document.body)` → recompute all overlay positions and emit `resize(height)`.
- For non-focused anchors, recompute on `resize`, `update_anchors`, and `request_anchor_positions` only — no continuous polling.
- For focused anchors (during the 1.5s pulse), recompute on `requestAnimationFrame` so the focused badge tracks smooth-scroll.

### Pick mode rendering

- On `enter_pick_mode`: companion sets `document.body.style.cursor = 'crosshair'`. Adds a transient outline `<div>` inside the overlay layer, sized to follow the bounding rect of the element under the cursor (`mousemove`, rAF-throttled).
- On `click` (document-level capture-phase, `stopImmediatePropagation()` + `preventDefault()` so the artifact's own handlers don't fire): computes the clicked element's `path` + `innerHash` + `clientRect`, posts `element_picked`, auto-exits pick mode.
- On `keydown` Esc: posts `pick_mode_exited`, auto-exits pick mode.
- On `exit_pick_mode` (parent-initiated): clears the outline, restores cursor, removes handlers.

### What the companion does NOT mutate

- No existing `<head>` content beyond appending a single `<style>` element.
- No element in `<body>` other than appending the overlay `<div>` and a transient `body.style.cursor`.
- No event handlers attached to artifact elements; all listeners are document-level capture-phase.
- No CSS variables on `:root`.

## Selection capture

```js
function onPossibleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const selectorText = sel.toString();
  if (selectorText.trim().length === 0) return;

  const container = nearestBlockAncestor(range.startContainer);
  const { prefix, suffix } = collectContext(container, range, 32);
  const containerPath = cssPath(container);

  const clientRects = Array.from(range.getClientRects()).map(serializeRect);

  const fingerprint = `${containerPath}|${prefix}|${selectorText}|${suffix}`;
  if (fingerprint === lastEmittedFingerprint && Date.now() - lastEmittedAt < 200) return;
  lastEmittedFingerprint = fingerprint;
  lastEmittedAt = Date.now();

  port.postMessage({
    type: 'selection_captured',
    anchor: { type: 'text-range', selectorText, prefix, suffix, containerPath },
    clientRects,
  });
}

document.addEventListener('mouseup', () => requestAnimationFrame(onPossibleSelection));
document.addEventListener('keyup',  () => requestAnimationFrame(onPossibleSelection));
```

A `requestAnimationFrame` wrap ensures `window.getSelection()` reflects the post-event state. The 200ms duplicate-fingerprint window suppresses rapid-fire mouseup/keyup spam.

## External-nav forwarding

The companion intercepts the two paths LLM-generated artifacts actually use:

### Anchor clicks

A single document-level capture-phase listener:

```js
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[target="_blank"], a[target="_top"]');
  if (!a || !a.href) return;
  e.preventDefault();
  port?.postMessage({ type: 'open_external', url: a.href });
}, true);
```

### `window.open` override

```js
const _origOpen = window.open;
window.open = function (url, ..._rest) {
  if (typeof url === 'string') {
    port?.postMessage({ type: 'open_external', url });
  }
  return null; // mimic the sandbox-blocked behavior of native window.open
};
```

The companion is `defer` + end-of-body, so this override runs after all inline artifact scripts. Most LLM-generated artifacts call `window.open` directly (don't cache the reference) so the override is effective in the common case.

**Known limitation worth flagging in the spec:** if an artifact's own script captured a reference to `window.open` *before* the companion's override installed, that cached reference still invokes the native (sandbox-blocked) `window.open` and the click does nothing. We accept this — the failure mode is "the link does nothing", not "the link does something dangerous."

### Form-submit interception

Out of scope here. `<form action="https://…" target="_blank">` is rare in LLM-generated content and the sandbox kills it silently already (`allow-popups` is dropped). Revisit reactively if real cases surface.

### Parent-side validation

```ts
// apps/web/src/companion/client.ts
export function isSafeExternalUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === 'https:';
}

export function handleOpenExternal({ url }: { url: string }): void {
  if (!isSafeExternalUrl(url)) {
    console.warn('[primer] rejected open_external', url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
```

Anything other than `https:` (including `http:`, `javascript:`, `data:`, relative URLs, garbage strings) is silently dropped. The console warn is for forensics during dev.

## Test harness

### Dev fixture endpoint

`apps/api/src/companion/fixtures/anchoring.html` is a checked-in raw HTML doc (no companion tag — the pipeline injects). Contents:

- Heading and several paragraphs of varied prose (so prefix/suffix uniqueness has real material).
- `<a href="https://example.com/external" target="_blank">External link</a>`.
- `<button onclick="window.open('https://example.com/popup')">https popup</button>`.
- `<button onclick="window.open('http://example.com/bad')">http popup</button>`.
- `<canvas id="demo-canvas" width="200" height="80"></canvas>`.
- An inline `<svg>` with several `<rect>` children.
- A `<button>` whose handler `setTimeout(() => document.body.appendChild(document.createElement('p')), 1000)` exercises `resize(height)`.

Hono route `GET /dev/fixtures/anchoring.html`:

- Registered in `createApp` *only* when `process.env.NODE_ENV !== 'production'`.
- Reads the fixture file from disk on each request (it's small; no caching needed in dev).
- Pipes it through the existing `transformHtml()` from sub-project 1 so the same sanitization + companion-script injection apply.
- Responds with the same headers as `GET /api/versions/:versionId/content`: locked `ARTIFACT_CSP`, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`.

### Harness page

React route `/dev/harness` in `apps/web` (always built; only useful when the API's dev route is registered). Layout:

- **Left column:** `<ArtifactIframe src="/dev/fixtures/anchoring.html" anchors={state.anchors} onMessage={…} />`.
- **Right column (debug pane):**
  - **Current selection:** last `selection_captured` event, JSON-pretty, with `[Save as anchor]` and `[Clear]` buttons.
  - **Saved anchors:** list of anchors currently held in React state. Each row: `[Highlight] [Drop]` actions.
  - **Pick mode:** `[Enter pick mode]` button; status indicator; list of captured `element_picked` anchors (saveable like selections).
  - **Message log:** chronological log of every inbound message and every outbound message (outbound prefixed `→`). Each entry shows timestamp + type + collapsed payload JSON.

Anchors are kept in plain React state with synthetic IDs (`harness-${nanoid()}`). No DB involvement; state is lost on reload — intentional.

### Configuration / NODE_ENV gating

- `apps/api/src/app.ts` (or `routes/dev*.ts`) registers the dev fixture route conditionally:
  ```ts
  if (process.env.NODE_ENV !== 'production') {
    registerDevFixtureRoute(app);
  }
  ```
- The React harness page is always built (it's a static route in the SPA bundle). In production, hitting `/dev/harness` succeeds at the React Router level but the iframe `src` 404s. Acceptable for v1.
- README quickstart gets a new line documenting `/dev/harness` for local testing.

## Testing strategy

End-to-end browser-level testing of `v1.js` is out of scope; the harness covers it manually. Automated Vitest coverage:

- `packages/shared/src/companion-protocol.test.ts`:
  - `parseInboundMessage(unknown)` round-trips a well-formed example of each message type at least once.
  - Returns `null` on malformed input (missing `type`, unknown `type`, wrong-shape payload).
- `apps/web/src/companion/client.test.ts`:
  - `isSafeExternalUrl('https://x')` → `true`.
  - `isSafeExternalUrl('http://x')` → `false`.
  - `isSafeExternalUrl('javascript:alert(1)')` → `false`.
  - `isSafeExternalUrl('data:text/html,…')` → `false`.
  - `isSafeExternalUrl('/relative/path')` → `false`.
  - `isSafeExternalUrl('not a url')` → `false`.
- `apps/api/src/routes/devFixture.test.ts`:
  - Hitting `GET /dev/fixtures/anchoring.html` returns 200 with the locked `ARTIFACT_CSP` header.
  - Body contains `<script src="/companion/v1.js"` (proves the upload pipeline ran).
  - Body contains the fixture's anchor element.

If `cssPath` / `collectContext` / `normalize` (the companion's pure helpers) get gnarly during implementation, the plan can choose to extract them and add Vitest coverage. They're not required to be testable in v1; the harness exercises them.

## Exit criteria

Sub-project 2 is **done** when all of these hold from `/dev/harness`:

1. The companion script (no longer a stub) loads in the artifact iframe on every visit. The parent establishes a `MessageChannel` on `iframe.load` and the iframe acknowledges the channel by using it for the first outbound message.
2. Selecting text in the fixture artifact emits `selection_captured` to the parent within ~100ms of mouseup. Payload includes `selectorText`, `prefix` ≤32 chars, `suffix` ≤32 chars, `containerPath`, and `clientRects` (one per visual line).
3. The harness "Save as anchor" button triggers `update_anchors`; a CSS Highlight is painted on the selected range in-iframe.
4. The harness "Highlight" button on a saved anchor triggers `highlight_anchor(id)`; the marker switches to the focused style for ~1.5s and the range scrolls into view.
5. Clicking `<a href="https://example.com/external" target="_blank">` in the fixture opens a new browser tab to that URL.
6. The fixture's `window.open('https://example.com/popup')` call opens a new browser tab to that URL.
7. The fixture's `window.open('http://example.com/bad')` call is silently dropped on the parent side. The harness's message log shows the rejected payload.
8. Entering pick mode changes the cursor to crosshair and outlines hovered elements. Clicking an element emits `element_picked` with `path`, 16-char `innerHash`, and `clientRect`. The companion auto-exits pick mode after the click. Pressing `Esc` while in pick mode emits `pick_mode_exited` and the harness's pick toggle reverts.
9. Saving an anchor whose text is not present in the live DOM (manually editable in the harness) yields `drifted: true` in the next `anchor_positions` response. No marker is rendered for drifted text-range anchors.
10. Clicking the "delayed body append" button in the fixture produces a `resize(height)` message with the new height value.
11. `pnpm verify` is green: typecheck, Vitest (parser round-trips, URL classification, dev fixture route headers), audit.

## Deferred / out of scope (restated)

- Element-path resolution fallback when text-range resolution fails (sub-project 7).
- Storing anchors against `Thread` rows (sub-project 3).
- Floating "Add comment" affordance, comment sidebar, real anchor IDs from threads, polling, edit/delete (sub-project 3).
- Form-submit interception (`<form target="_blank">`).
- Production deploy and proper authentication on dev routes — `NODE_ENV` gating is the v1 fence.
- Slack notifications (sub-project 6).
- Real Okta auth, multi-user, CSRF (sub-project 5).

## Open items the implementation plan should resolve

These don't change the design — they're details the plan should nail down using then-current information:

- The exact set of Hono / React imports needed for the new files (boilerplate per existing patterns).
- Whether `nanoid` is needed in `apps/web` for synthetic harness IDs, or whether `crypto.randomUUID()` is enough. (Browser-native `crypto.randomUUID()` is sufficient on Chrome 92+, which our user base has. Plan defaults to native, picks nanoid only if a reason emerges.)
- The exact shape of `collectContext` — single-pass TreeWalker vs separate forward/backward walks — left to the plan. The invariant is: same normalization as resolution.
- Whether to register a single global `error` listener inside the companion to swallow internal errors so they don't bubble into the artifact's own error reporting. (Lean toward yes; document in plan.)
- Whether the `<style>` element prepended by the companion gets a `data-primer="1"` attribute for inspection during debugging. (Lean yes — costs nothing.)
