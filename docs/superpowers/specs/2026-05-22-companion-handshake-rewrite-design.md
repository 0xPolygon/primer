# Companion Handshake + Click Hit-Test Rewrite — Design

**Date:** 2026-05-22
**Status:** Approved

## Goal

Make text-range highlighting in the artifact iframe reliable across page loads and browsers, and make clicking a highlight actually focus its thread. Also raise the visibility of the focused-thread state in the sidebar so it's distinguishable at a glance in light mode.

## Why the current implementation fails

Three independent bugs, dominated by one:

1. **Init race (root cause of most reports).** `ArtifactIframe.tsx` attaches its `iframe.addEventListener('load', handleLoad)` inside a `useEffect`. When the artifact bytes are cached (Brave does this aggressively), the iframe's `load` event can fire between React's commit and the effect running. The listener attaches too late. `handleLoad` never runs. The companion (`apps/api/src/companion/v1.js:52-60`) times out after 2s, stands down, and its `port` stays null forever for that mount. From there:
   - Existing comments never get an `init` payload, so `renderTextRangeMarkers()` runs with empty `knownAnchors` — no highlights.
   - Every subsequent `update_anchors` posted by the parent goes nowhere because `senderRef.current?.(…)` is null.
   - Every click on a highlight is dropped at `v1.js:555 if (!port) return;`.
   - Every `set_focused_anchor` from the sidebar is dropped for the same reason — explaining "click a thread, iframe doesn't scroll".
   - The whole failure is silent. Companion logs land in the iframe's opaque-origin console, invisible to anyone debugging at the page level.

2. **Click hit-test is brittle.** `findAnchorAtClick` iterates `rangeByAnchorId`, computes `range.getClientRects()`, and does point-in-rect math against the click coordinates. Sub-pixel rounding, gaps between line boxes, CSS transforms on ancestors, and overlapping anchors all produce misses or wrong-match results. Even with the init race fixed, this stays unreliable on closely-spaced anchors.

3. **Sidebar focus state is invisible in light mode.** `ThreadCard` uses `bg-yellow-50/40 ring-1 ring-yellow-200` for the focused card. On a white sidebar background it's basically indistinguishable from an unfocused card, and competes with the quote-preview's own `border-yellow-300` left bar.

## Non-goals

- **No MutationObserver / dynamic-content re-resolution.** The team's active artifacts are mostly static HTML. The "highlights vanish after a chart renders" failure mode hasn't been reported. Out of scope.
- **No DOM mutation for highlights.** We keep the CSS Custom Highlight API for paint. No `Range.surroundContents` wrapping, no injected `<span>`s into the artifact tree.
- **No artifact-CSP changes.** Companion still loads via `/companion/v1.js`. Sandbox attributes unchanged.
- **No anchor protocol changes.** `TextRangeAnchor` and `ElementPathAnchor` shapes stay as-is.
- **No new dependencies.** `caretRangeFromPoint` / `caretPositionFromPoint` are platform APIs.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Parent (apps/web)                                          │
│                                                            │
│  ArtifactIframe.tsx                                        │
│    ├─ symmetric handshake (load event + companion_ready)   │
│    ├─ idempotent sendInit (per contentWindow)              │
│    └─ pending-message buffer (drain on port ready)         │
│                                                            │
│  routes/document.tsx                                       │
│    └─ companion_log / companion_panic → console            │
│                                                            │
│  components/ThreadCard.tsx                                  │
│    └─ amber focused-thread styling                          │
└─────────────────────┬──────────────────────────────────────┘
                      │ MessageChannel + window.postMessage
                      ▼
┌────────────────────────────────────────────────────────────┐
│ Companion (apps/api/src/companion/v1.js)                   │
│                                                            │
│  Handshake                                                  │
│    ├─ POST companion_ready on script-end                   │
│    ├─ retry every 500ms while port is null (cap 10)        │
│    └─ companion_panic to window.parent if exhausted        │
│                                                            │
│  Click hit-test                                             │
│    └─ caretRangeFromPoint + Range.comparePoint              │
│       (rect-check as cheap reject filter)                  │
│                                                            │
│  Logging                                                    │
│    ├─ buffer pre-port logs                                  │
│    └─ flush + stream over port as companion_log             │
└────────────────────────────────────────────────────────────┘
```

## Component 1: Symmetric handshake

**Goal:** decouple init delivery from the iframe `load` event's timing relative to React's effect schedule.

### Parent side (`ArtifactIframe.tsx`)

```ts
useEffect(() => {
  const iframe = iframeRef.current;
  if (!iframe) return;

  let initSent = false;
  const sendInit = () => {
    if (initSent) return;
    if (!iframe.contentWindow) return;
    initSent = true;

    const channel = new MessageChannel();
    const port = channel.port1;
    portRef.current = port;
    port.onmessage = (event) => {
      const parsed = parseInboundMessage(event.data);
      if (parsed) onMessageRef.current(parsed);
    };
    port.start();

    iframe.contentWindow.postMessage(
      { type: 'init', anchors: anchorsRef.current } satisfies OutboundProtocolMessage,
      '*',
      [channel.port2],
    );

    // Hand the sender to the parent route and drain any buffered messages.
    registerSenderRef.current?.((msg) => port.postMessage(msg));
    drainPending(port);
  };

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'companion_ready') {
      sendInit();
    } else if (data.type === 'companion_panic') {
      // eslint-disable-next-line no-console
      console.error('[companion] panic:', data.reason);
    }
  };

  const onLoad = () => sendInit();

  window.addEventListener('message', onWindowMessage);
  iframe.addEventListener('load', onLoad);

  return () => {
    window.removeEventListener('message', onWindowMessage);
    iframe.removeEventListener('load', onLoad);
    portRef.current?.close();
    portRef.current = null;
    registerSenderRef.current?.(null);
  };
}, [src]);
```

Key properties:

- `sendInit` is idempotent — guarded by `initSent`. The first of (load event, companion_ready, retry) wins; the rest are no-ops.
- The window-level `message` listener filters strictly on `event.source === iframe.contentWindow` so unrelated `postMessage` traffic on the page never triggers us.
- Cleanup on src change tears down both listeners + the port.

### Pending-message buffer

Scoped per-mount (declared inside the `useEffect` so it resets when `src` changes — buffered messages for an old version should not leak into a new one):

```ts
const pending: OutboundProtocolMessage[] = [];
function drainPending(port: MessagePort) {
  while (pending.length > 0) port.postMessage(pending.shift()!);
}
```

The buffer's primary role is defensive — today the existing `registerSender` callback in `document.tsx` already pushes `update_anchors` + `request_anchor_positions` synchronously when sender is set, so the common path doesn't need buffering. The buffer guards against the rare case where the parent route's effects mutate state (e.g., a focus change) exactly during the handshake window. Bounded at 50 entries to prevent unbounded growth if the handshake panics. The sender given to the parent route via `registerSender` is `(m) => port.postMessage(m)` — i.e., it only ever runs after the port is ready, so callers never see "buffered or sent" non-determinism.

### Companion side (`v1.js`)

Replace the current "wait for window message, time out after 2s" flow with a posting-driven flow:

```js
const READY_RETRY_MS = 500;
const READY_MAX_TRIES = 10;
let readyTimer = null;
let readyTries = 0;

function postReady() {
  try {
    window.parent.postMessage({ type: 'companion_ready', v: 1 }, '*');
  } catch {}
}

function startReadyRetry() {
  postReady();
  readyTimer = setInterval(() => {
    if (port !== null) {
      clearInterval(readyTimer);
      readyTimer = null;
      return;
    }
    readyTries += 1;
    if (readyTries >= READY_MAX_TRIES) {
      clearInterval(readyTimer);
      readyTimer = null;
      try {
        window.parent.postMessage(
          { type: 'companion_panic', reason: 'init handshake exhausted retries' },
          '*',
        );
      } catch {}
      return;
    }
    postReady();
  }, READY_RETRY_MS);
}

// Init listener — unchanged except we clear the retry timer on success.
let onWindowMessage = (event) => {
  if (!event.ports || event.ports.length === 0) return;
  if (!event.data || event.data.type !== 'init') return;
  port = event.ports[0];
  port.onmessage = onPortMessage;
  port.start();
  if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
  if (Array.isArray(event.data.anchors)) {
    knownAnchors = event.data.anchors;
    renderTextRangeMarkers();
    renderElementBadges();
  }
  flushLogBuffer();
  if (onWindowMessage) {
    window.removeEventListener('message', onWindowMessage);
    onWindowMessage = null;
  }
};

window.addEventListener('message', onWindowMessage);
startReadyRetry();
```

The existing 2s timeout block is removed — replaced by the bounded retry above.

## Component 2: Caret-based click hit-test

Replace the rect math in `findAnchorAtClick` with caret + comparePoint:

```js
function findTextRangeAtClick(event) {
  const x = event.clientX;
  const y = event.clientY;

  // Cheap reject: if no range's bbox contains the click, bail.
  let anyRectHit = false;
  for (const range of rangeByAnchorId.values()) {
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        anyRectHit = true;
        break;
      }
    }
    if (anyRectHit) break;
  }
  if (!anyRectHit) return null;

  // Authoritative: caret-position lookup.
  const caret =
    typeof document.caretRangeFromPoint === 'function'
      ? document.caretRangeFromPoint(x, y)
      : typeof document.caretPositionFromPoint === 'function'
      ? document.caretPositionFromPoint(x, y)
      : null;
  if (!caret) return null;

  const node =
    'startContainer' in caret ? caret.startContainer : caret.offsetNode;
  const offset =
    'startOffset' in caret ? caret.startOffset : caret.offset;
  if (!node) return null;

  let best = null;
  let bestLength = Infinity;
  for (const [anchorId, range] of rangeByAnchorId) {
    let inside;
    try { inside = range.comparePoint(node, offset) === 0; }
    catch { inside = false; }   // detached node
    if (!inside) continue;
    const len = range.toString().length;
    if (len < bestLength) { best = anchorId; bestLength = len; }
  }
  return best;
}
```

`findAnchorAtClick` keeps its current structure for the badge case:

```js
function findAnchorAtClick(event) {
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return null;

  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;

  const badge = target.closest('.__primer_badge__');
  if (badge instanceof HTMLElement && badge.dataset.anchorId) {
    return badge.dataset.anchorId;
  }

  for (const [anchorId, entry] of elementByAnchorId) {
    if (entry.el.contains(target)) return anchorId;
  }

  return findTextRangeAtClick(event);
}
```

Properties:

- Browser-native caret positioning matches what the user perceives as "inside this text."
- Overlapping ranges resolve deterministically: smallest containing range wins.
- The rect-bbox fast-reject filter is O(n × rects) but small in practice, and we keep it because it bails out cheaply on every click outside the visible highlight area.
- `try/catch` around `comparePoint` because detached nodes throw. No retry on failure — same as today.

## Component 3: Log piping

### Protocol additions (`packages/shared/src/companion-protocol.ts`)

Three new message types, all inbound (companion → parent):

```ts
export type MsgCompanionReady = { type: 'companion_ready'; v: 1 };
export type MsgCompanionLog = {
  type: 'companion_log';
  level: 'info' | 'warn' | 'error';
  message: string;
};
export type MsgCompanionPanic = {
  type: 'companion_panic';
  reason: string;
};
```

`companion_ready` and `companion_panic` travel via `window.postMessage` to the parent (not the channel — they exist precisely for the case where the channel isn't established). `companion_log` travels over the established port.

Add them to `parseInboundMessage` for the port (companion_log only — the others are handled in the window-level listener in `ArtifactIframe`).

### Companion-side log helper

```js
const logBuffer = [];
function log(level, ...args) {
  const message = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  // Local iframe console always, for in-iframe DevTools sessions.
  // eslint-disable-next-line no-console
  console.log(`[primer/companion][${level}]`, ...args);
  if (port) {
    try { port.postMessage({ type: 'companion_log', level, message }); }
    catch {}
  } else {
    logBuffer.push({ level, message });
    if (logBuffer.length > 100) logBuffer.shift();   // bounded
  }
}
log.info = (...a) => log('info', ...a);
log.warn = (...a) => log('warn', ...a);
log.error = (...a) => log('error', ...a);

function flushLogBuffer() {
  if (!port) return;
  while (logBuffer.length > 0) {
    const entry = logBuffer.shift();
    try { port.postMessage({ type: 'companion_log', level: entry.level, message: entry.message }); }
    catch { break; }
  }
}
```

All existing `log(…)` call sites stay the same — they now route through `log.info` (which is the default). Update each call site to use `log.info` / `log.warn` / `log.error` as appropriate (e.g., `init received` is `info`, `CSS Custom Highlight API not available` is `warn`).

### Parent-side consumer (`document.tsx`)

In the existing `onMessage` switch:

```ts
case 'companion_log':
  // eslint-disable-next-line no-console
  console[msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'log'](
    '[companion]',
    msg.message,
  );
  break;
```

For `companion_ready` and `companion_panic`, those don't come through `onMessage` (they're window-level, handled in `ArtifactIframe`). Panic gets surfaced as a `console.error` so it shows up clearly.

## Component 4: Sidebar focused-thread styling

Single-line change in `ThreadCard.tsx`:

```tsx
const focusedClass = isFocused
  ? 'bg-amber-100 dark:bg-amber-900/40 ring-2 ring-inset ring-amber-400 dark:ring-amber-600 shadow-sm'
  : '';
```

Rationale:

- `amber-100` (vs `yellow-50/40`) is high enough saturation to be obvious in light mode against the white sidebar.
- `ring-2 ring-amber-400` is the unmistakable "this is selected" outline.
- `shadow-sm` lifts the card subtly so it stands out when scrolling.
- The quote-preview's existing `border-yellow-300` left bar is left untouched — it's a *type* indicator (this card refers to a yellow highlight) and shouldn't change with focus state. The amber-vs-yellow tonal split keeps the two signals distinguishable.
- Dark-mode `amber-900/40` + `amber-600` ring matches the existing dark-mode amber palette used elsewhere (e.g., read-only banner).

## Failure modes still possible after this change

- **Hostile artifact swallows our messages.** If artifact JS replaces `window.postMessage` or installs a capture-phase listener that calls `stopImmediatePropagation`, our handshake won't work. Out of scope — the artifact threat model already calls this out.
- **Browser without `caretRangeFromPoint` AND `caretPositionFromPoint`.** Neither has existed broadly for years; no shipping browser today is missing both. If the fallback ever returns null we skip the click. We get a `companion_log` warn for visibility.
- **Companion panic.** If the 5-second retry exhausts, we report it. The user sees no highlights, but at least the page console shows `[companion] init handshake exhausted retries`. That's an honest fail mode, not a silent one.

## Testing

### Vitest (automated)

- **`ArtifactIframe.test.tsx` (new):**
  - Pending-message buffer: messages enqueued before port ready, drained in order after.
  - Idempotent init: simulate `load` event + a `companion_ready` window message; assert `iframe.contentWindow.postMessage` is invoked exactly once with `{type:'init', …}`.
- **`ThreadCard` focused class:** render with `isFocused={true}` and `false`; assert the amber classes are / aren't applied.
- **Companion protocol parsing:** extend the existing `companion/protocol.test.ts` to round-trip `companion_log` (the port-side message).

### Manual smoke (after merge, before push)

1. Open `outpost-checklist.html` with ≥2 existing comments. Hard-reload 5× — highlights paint every time.
2. Soft-reload 5× (Cmd-R / Ctrl-R) — highlights still paint every time. *This is the cached-load race that exposed Bug 1.*
3. Click a highlight in the iframe → sidebar opens (if collapsed), card scrolls into view, amber outline visible.
4. Click a thread card in the sidebar → iframe scrolls to the highlighted text.
5. Page console shows `[companion] init received, anchors: N` and subsequent logs streaming through.
6. Select text in the iframe → "Add comment in sidebar →" pill appears as before.
7. Switch versions on a document → new highlights paint on the new version's iframe.
8. Try at least one other artifact the team has flagged as broken, ideally one with deeply nested DOM or inline scripts.

## Files touched

- `apps/web/src/components/ArtifactIframe.tsx` — symmetric handshake, pending buffer.
- `apps/web/src/components/ArtifactIframe.test.tsx` — new tests (idempotent init, buffer).
- `apps/web/src/routes/document.tsx` — handle `companion_log` (the panic surface is in ArtifactIframe directly).
- `apps/web/src/components/ThreadCard.tsx` — amber focused styling.
- `apps/api/src/companion/v1.js` — `companion_ready` post + retry, panic on exhaustion, caret-based hit-test, log streaming with pre-port buffer.
- `packages/shared/src/companion-protocol.ts` — new message types; update `parseInboundMessage` for `companion_log`.
- `apps/web/src/companion/protocol.test.ts` — extend with `companion_log` round-trip.

## Risks

- **Companion `<script defer>` execution timing.** `defer` runs after parsing but before `load`. The first `companion_ready` post can therefore fire before the parent's effect attaches. The 500ms retry covers this.
- **A page hosting multiple iframes simultaneously.** Today we only ever mount one ArtifactIframe at a time. The `event.source` filter on the window listener already scopes us correctly — if we ever do mount two, each instance's `ArtifactIframe` effect filters to its own `contentWindow`, so they don't cross-talk.
- **postMessage targetOrigin.** We use `'*'` because the iframe is sandboxed to an opaque origin. Same as today. Not new attack surface.
- **`event.source` identity across navigation.** When the iframe `src` changes, the `useEffect` cleanup runs first (removes the listener for the old contentWindow), then re-runs with the new src (attaches a fresh listener bound to the new contentWindow). No stale-listener risk.

## What gets committed

Three commits, by component boundary:

1. `feat(commenting): symmetric handshake + log pipe` — protocol types, ArtifactIframe, document.tsx, companion handshake + logging, test.
2. `fix(commenting): caret-based click hit-test` — companion v1.js click handler rewrite.
3. `feat(web): stronger focused-thread treatment in sidebar` — ThreadCard styling + test.

Splitting along boundaries makes review and revert easy. If commit 2 turns out worse than the rect math, we can revert it independently.
