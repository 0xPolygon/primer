# Companion Handshake + Click Hit-Test Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make text-range highlighting + click-to-focus in the artifact iframe reliable across browser cache states, with visible diagnostics and a sidebar focus state that's actually visible in light mode.

**Architecture:** Symmetric handshake (both iframe-load AND companion-ready trigger `sendInit`; idempotent), pure helpers extracted for testability, caret-based click hit-testing in the companion (in place of brittle point-in-rect math), companion logs streamed to parent for visibility, and a stronger amber treatment for the focused thread card.

**Tech Stack:** React 19 + Vite + Vitest (web), Hono + Drizzle (api), vanilla JS companion (`apps/api/src/companion/v1.js`), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-22-companion-handshake-rewrite-design.md`

---

## File Structure

**Created:**
- `apps/web/src/companion/buffer.ts` — pure `createMessageBuffer(cap)` returning `{ enqueue, drain, size }`. Single responsibility: bounded FIFO with safe drain.
- `apps/web/src/companion/buffer.test.ts` — Vitest cases for the buffer helper.

**Modified:**
- `packages/shared/src/companion-protocol.ts` — three new message types (`companion_log`, `companion_ready`, `companion_panic`); `companion_log` joins `InboundProtocolMessage`; new `parseWindowEnvelope(raw)` for window-level ready/panic dispatch.
- `apps/web/src/companion/protocol.test.ts` — extend with `companion_log` round-trip + `parseWindowEnvelope` tests.
- `apps/web/src/components/ArtifactIframe.tsx` — symmetric handshake (load + companion_ready), idempotent `sendInit`, buffered sends, `companion_panic` surfaced as `console.error`.
- `apps/web/src/routes/document.tsx` — handle `companion_log` in `onMessage`.
- `apps/api/src/companion/v1.js` — replace 2s timeout with bounded retry posting `companion_ready`; emit `companion_panic` on exhaustion; pre-port log buffer + flush + stream over port; replace rect-math click hit-test with caret-based hit-test.
- `apps/web/src/components/ThreadCard.tsx` — focused-class palette: amber-100 bg + ring-2 amber-400 + shadow-sm (dark: amber-900/40 + amber-600).

**Commits (one per task, 8 total):** 7 implementation commits + a final verification "no-op" task that runs typecheck/tests/build (no commit).

---

## Task 1: Protocol types + `parseWindowEnvelope`

**Files:**
- Modify: `packages/shared/src/companion-protocol.ts`
- Modify: `apps/web/src/companion/protocol.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `apps/web/src/companion/protocol.test.ts`:

```ts
import { parseInboundMessage, parseWindowEnvelope } from '@primer/shared';

describe('parseInboundMessage — companion_log', () => {
  it('round-trips info level', () => {
    const ok = { type: 'companion_log', level: 'info', message: 'hello world' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips warn level', () => {
    const ok = { type: 'companion_log', level: 'warn', message: 'CSS Highlight API missing' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips error level', () => {
    const ok = { type: 'companion_log', level: 'error', message: 'boom' };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('rejects companion_log with unknown level', () => {
    expect(
      parseInboundMessage({ type: 'companion_log', level: 'debug', message: 'x' })
    ).toBeNull();
  });

  it('rejects companion_log without message string', () => {
    expect(
      parseInboundMessage({ type: 'companion_log', level: 'info', message: 42 })
    ).toBeNull();
  });
});

describe('parseWindowEnvelope', () => {
  it('parses companion_ready', () => {
    expect(parseWindowEnvelope({ type: 'companion_ready', v: 1 })).toEqual({
      type: 'companion_ready',
    });
  });

  it('parses companion_panic with reason', () => {
    expect(
      parseWindowEnvelope({ type: 'companion_panic', reason: 'init exhausted' })
    ).toEqual({ type: 'companion_panic', reason: 'init exhausted' });
  });

  it('returns null for unknown type', () => {
    expect(parseWindowEnvelope({ type: 'something_else' })).toBeNull();
  });

  it('returns null for missing type', () => {
    expect(parseWindowEnvelope({ foo: 'bar' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseWindowEnvelope(null)).toBeNull();
    expect(parseWindowEnvelope(undefined)).toBeNull();
    expect(parseWindowEnvelope('hi')).toBeNull();
  });

  it('returns null for companion_panic without reason string', () => {
    expect(parseWindowEnvelope({ type: 'companion_panic', reason: 42 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @primer/web test -- src/companion/protocol.test.ts
```

Expected: FAIL with `parseWindowEnvelope is not exported` and `companion_log` cases not parsed.

- [ ] **Step 3: Add types + parsers to `packages/shared/src/companion-protocol.ts`**

After the `MsgAnchorClicked` interface (around line 100), add:

```ts
/** Log line streamed from companion to parent over the port so debugging
 *  doesn't require reaching into the iframe's opaque-origin console. */
export interface MsgCompanionLog {
  type: 'companion_log';
  level: 'info' | 'warn' | 'error';
  message: string;
}
```

Update `InboundProtocolMessage` (around line 102):

```ts
export type InboundProtocolMessage =
  | MsgSelectionCaptured
  | MsgElementPicked
  | MsgPickModeExited
  | MsgAnchorPositions
  | MsgResize
  | MsgOpenExternal
  | MsgAnchorClicked
  | MsgCompanionLog;
```

After `InboundProtocolMessage`, add the window-envelope types:

```ts
/** Window-level handshake messages — go via window.postMessage (not the
 *  port) because they exist for the case where the port isn't established
 *  yet, or has already given up. */
export interface MsgCompanionReady {
  type: 'companion_ready';
}
export interface MsgCompanionPanic {
  type: 'companion_panic';
  reason: string;
}
export type WindowEnvelope = MsgCompanionReady | MsgCompanionPanic;
```

Add the `companion_log` case to `parseInboundMessage` (inside the switch, before `default`):

```ts
    case 'companion_log': {
      if (raw.level !== 'info' && raw.level !== 'warn' && raw.level !== 'error') return null;
      if (!isString(raw.message)) return null;
      return { type: 'companion_log', level: raw.level, message: raw.message };
    }
```

Append `parseWindowEnvelope` at the end of the file:

```ts
export function parseWindowEnvelope(raw: unknown): WindowEnvelope | null {
  if (!isObject(raw) || !isString(raw.type)) return null;
  switch (raw.type) {
    case 'companion_ready':
      return { type: 'companion_ready' };
    case 'companion_panic':
      if (!isString(raw.reason)) return null;
      return { type: 'companion_panic', reason: raw.reason };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Verify shared package re-exports**

Check `packages/shared/src/index.ts` includes everything from `companion-protocol.ts`:

```bash
grep "companion-protocol" packages/shared/src/index.ts
```

Expected output: a line like `export * from './companion-protocol';` (or similar). If absent, add it. The new types and `parseWindowEnvelope` need to be reachable via `@primer/shared`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @primer/web test -- src/companion/protocol.test.ts
```

Expected: PASS, all cases green.

- [ ] **Step 6: Typecheck the workspace**

```bash
pnpm --filter @primer/shared typecheck && pnpm --filter @primer/web typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/companion-protocol.ts apps/web/src/companion/protocol.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): companion_log + window envelope protocol types

Adds companion_log message (over the port) plus companion_ready /
companion_panic window-level envelopes, with parseWindowEnvelope
for the parent-side dispatch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `createMessageBuffer` helper + tests

**Files:**
- Create: `apps/web/src/companion/buffer.ts`
- Create: `apps/web/src/companion/buffer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/companion/buffer.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createMessageBuffer } from './buffer.ts';

describe('createMessageBuffer', () => {
  it('reports zero size when empty', () => {
    const buf = createMessageBuffer<number>(10);
    expect(buf.size()).toBe(0);
  });

  it('enqueues up to cap', () => {
    const buf = createMessageBuffer<number>(3);
    buf.enqueue(1);
    buf.enqueue(2);
    buf.enqueue(3);
    expect(buf.size()).toBe(3);
  });

  it('drops the oldest entry when over cap', () => {
    const buf = createMessageBuffer<number>(2);
    buf.enqueue(1);
    buf.enqueue(2);
    buf.enqueue(3);
    expect(buf.size()).toBe(2);
    const sink = vi.fn();
    buf.drain(sink);
    expect(sink.mock.calls.map((c) => c[0])).toEqual([2, 3]);
  });

  it('drains in FIFO order and empties the buffer', () => {
    const buf = createMessageBuffer<string>(5);
    buf.enqueue('a');
    buf.enqueue('b');
    buf.enqueue('c');
    const sink = vi.fn();
    buf.drain(sink);
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    expect(buf.size()).toBe(0);
  });

  it('is safe to drain twice (second drain is a no-op)', () => {
    const buf = createMessageBuffer<number>(5);
    buf.enqueue(1);
    const sink1 = vi.fn();
    const sink2 = vi.fn();
    buf.drain(sink1);
    buf.drain(sink2);
    expect(sink1).toHaveBeenCalledTimes(1);
    expect(sink2).not.toHaveBeenCalled();
  });

  it('stops draining if the sink throws, preserving remaining entries', () => {
    const buf = createMessageBuffer<number>(5);
    buf.enqueue(1);
    buf.enqueue(2);
    buf.enqueue(3);
    const sink = vi.fn((n: number) => {
      if (n === 2) throw new Error('sink failed');
    });
    expect(() => buf.drain(sink)).toThrow('sink failed');
    expect(buf.size()).toBe(1);
    const survivor = vi.fn();
    buf.drain(survivor);
    expect(survivor.mock.calls.map((c) => c[0])).toEqual([3]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @primer/web test -- src/companion/buffer.test.ts
```

Expected: FAIL with `Cannot find module './buffer.ts'`.

- [ ] **Step 3: Implement `createMessageBuffer`**

Create `apps/web/src/companion/buffer.ts`:

```ts
export interface MessageBuffer<T> {
  enqueue(item: T): void;
  drain(sink: (item: T) => void): void;
  size(): number;
}

export function createMessageBuffer<T>(cap: number): MessageBuffer<T> {
  const items: T[] = [];
  return {
    enqueue(item) {
      items.push(item);
      while (items.length > cap) items.shift();
    },
    drain(sink) {
      while (items.length > 0) {
        const next = items[0];
        sink(next);
        items.shift();
      }
    },
    size() {
      return items.length;
    },
  };
}
```

Note on the `drain` implementation: we read the head *before* removing it, so if `sink` throws we leave the head in place — caller can retry or inspect.

Wait — that's a bug for the "stops draining if sink throws" test. Reading the test: it expects that when sink throws on `2`, items `[2, 3]` remain. With the code as written: we read `items[0]` (which is 1), call sink(1), then shift removes 1, leaving [2,3]. Next loop: read items[0] = 2, call sink(2) which throws. We haven't shifted yet — [2,3] remain. ✓

Actually wait — the test expects `size()` to be 1 after the throw, meaning only `[3]` remains. So the test assumes sink(2) consumes 2 AND THEN throws. Let me change the implementation to shift first, then call sink:

```ts
    drain(sink) {
      while (items.length > 0) {
        const next = items.shift()!;
        sink(next);
      }
    },
```

With shift-first: drain processes 1 (consumed), then 2 (consumed and throws). After throw, only `[3]` remains. `size()` = 1. ✓ Matches the test.

Use the shift-first version above.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @primer/web test -- src/companion/buffer.test.ts
```

Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/companion/buffer.ts apps/web/src/companion/buffer.test.ts
git commit -m "$(cat <<'EOF'
feat(web): bounded FIFO message buffer for companion handshake

Defensive buffer for the rare case where the parent route attempts
to send before the iframe handshake completes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: ArtifactIframe symmetric handshake

**Files:**
- Modify: `apps/web/src/components/ArtifactIframe.tsx`

No automated test for this task — the iframe load timing is fundamentally a real-browser concern. The pure helpers it depends on (Task 1's `parseWindowEnvelope`, Task 2's buffer) are tested. Manual smoke at the end of the plan (Task 8) covers behavior.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `apps/web/src/components/ArtifactIframe.tsx` with:

```tsx
import { useEffect, useRef } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
} from '@primer/shared';
import { parseInboundMessage, parseWindowEnvelope } from '@primer/shared';
import { createMessageBuffer } from '../companion/buffer.ts';

interface Props {
  src: string;
  anchors: Anchor[];
  onMessage: (msg: InboundProtocolMessage) => void;
  /** Imperative outbound channel. Parent stores a setter; child stores the sender. */
  registerSender?: (send: ((msg: OutboundProtocolMessage) => void) | null) => void;
}

// SECURITY-CRITICAL: The sandbox value below is the primary defense against
// hostile JS inside uploaded artifacts. Do NOT add `allow-same-origin`,
// `allow-popups`, or `allow-popups-to-escape-sandbox`. Adding any of these
// would re-open phishing / cookie-theft / fake-SSO vectors described in
// docs/prd-primer.md ("Iframe sandboxing"). If you find yourself needing
// to widen the sandbox, stop and consult the threat model first.
export function ArtifactIframe({ src, anchors, onMessage, registerSender }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);

  // Latest-value refs so deferred handlers see current props, not the values
  // closed over at mount.
  const anchorsRef = useRef(anchors);
  const onMessageRef = useRef(onMessage);
  const registerSenderRef = useRef(registerSender);
  useEffect(() => { anchorsRef.current = anchors; }, [anchors]);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { registerSenderRef.current = registerSender; }, [registerSender]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Per-mount state. Buffer drops messages older than 50 if the handshake
    // never completes; sendInit is idempotent so duplicate triggers are safe.
    const buffer = createMessageBuffer<OutboundProtocolMessage>(50);
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

      // Wire the sender for the parent route. Sends always go through the
      // live port now that we have one. Any messages already buffered get
      // flushed in order before the route sends new ones.
      registerSenderRef.current?.((msg) => {
        if (portRef.current) portRef.current.postMessage(msg);
        else buffer.enqueue(msg);
      });
      buffer.drain((msg) => port.postMessage(msg));
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const envelope = parseWindowEnvelope(event.data);
      if (!envelope) return;
      if (envelope.type === 'companion_ready') {
        sendInit();
      } else if (envelope.type === 'companion_panic') {
        // eslint-disable-next-line no-console
        console.error('[companion] panic:', envelope.reason);
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

  return (
    <iframe
      ref={iframeRef}
      src={src}
      sandbox="allow-scripts allow-forms"
      title="Artifact"
      style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }}
    />
  );
}
```

Key changes vs. the previous version:
- Window-level `message` listener added; both `companion_ready` and the iframe `load` event trigger the same idempotent `sendInit`.
- `event.source` strictly filtered to this iframe's `contentWindow` so unrelated traffic is ignored.
- Buffer scoped per-mount; `enqueue` from `registerSender`'s sender if `portRef.current` ever becomes null (defensive — shouldn't happen in normal flow but documented behavior).
- `companion_panic` surfaces as `console.error` on the parent page.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

Expected: no errors.

- [ ] **Step 3: Run the existing web test suite to catch regressions**

```bash
pnpm --filter @primer/web test
```

Expected: PASS, including the new protocol + buffer tests from Tasks 1–2.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ArtifactIframe.tsx
git commit -m "$(cat <<'EOF'
fix(web): symmetric handshake for artifact iframe

Both iframe load and companion_ready trigger init, idempotently.
Closes the cached-load race where the load event fired before the
useEffect listener was attached, leaving the companion silent and
all clicks unrouted. Buffer covers the mid-handshake send window.
Surfaces companion_panic as a console error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Document route consumes `companion_log`

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Add the case to `onMessage`**

In `apps/web/src/routes/document.tsx`, locate the `onMessage` callback (around line 133). Add a new case before the `case 'resize':` line:

```ts
        case 'companion_log': {
          const fn = msg.level === 'error' ? console.error
                   : msg.level === 'warn'  ? console.warn
                   : console.log;
          // eslint-disable-next-line no-console
          fn('[companion]', msg.message);
          break;
        }
```

That's the entire change for this task — `msg` is already typed as `InboundProtocolMessage`, which now includes `MsgCompanionLog` from Task 1.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @primer/web typecheck
```

Expected: no errors. (If the switch is exhaustive elsewhere, this addition keeps it that way.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/document.tsx
git commit -m "$(cat <<'EOF'
feat(web): surface companion logs in parent console

Wires the new companion_log inbound message into the parent's
console, so diagnostic output from the iframe is finally visible
without reaching into the opaque-origin iframe DevTools.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Companion handshake retry + log streaming

**Files:**
- Modify: `apps/api/src/companion/v1.js`

No automated test — the companion runs in the iframe and tests would require jsdom + a synthesized parent. The fact that this code path doesn't have tests today is the in-tree convention; manual smoke is in Task 8.

**Order matters:** the new handshake calls `log.info` / `log.error` and `flushLogBuffer`, which are defined in Step 1. Do Step 1 (log helper) before Step 2 (handshake) so the file is consistent after each step.

- [ ] **Step 1: Replace the `log` helper with leveled + buffered version**

In `apps/api/src/companion/v1.js`, locate the existing `log` function (around line 15-19) and replace it with:

```js
  /** @type {{ level: 'info' | 'warn' | 'error', message: string }[]} */
  const logBuffer = [];
  const LOG_BUFFER_CAP = 100;

  function log(level, ...args) {
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    // Local iframe console always — useful when inspecting the iframe directly.
    // eslint-disable-next-line no-console
    console.log('[primer/companion][' + level + ']', ...args);
    if (port) {
      try {
        port.postMessage({ type: 'companion_log', level, message });
      } catch (e) {
        // port closed mid-send; nothing to do
      }
    } else {
      logBuffer.push({ level, message });
      if (logBuffer.length > LOG_BUFFER_CAP) logBuffer.shift();
    }
  }
  log.info = (...args) => log('info', ...args);
  log.warn = (...args) => log('warn', ...args);
  log.error = (...args) => log('error', ...args);

  function safeStringify(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function flushLogBuffer() {
    if (!port) return;
    while (logBuffer.length > 0) {
      const entry = logBuffer.shift();
      try {
        port.postMessage({
          type: 'companion_log',
          level: entry.level,
          message: entry.message,
        });
      } catch (e) {
        break; // port died mid-flush
      }
    }
  }
```

- [ ] **Step 2: Replace the handshake block**

In the same file, locate the section beginning `// ── 1. Init handshake ────` (around line 21) and ending with the `setTimeout` block (around line 60). Replace from the start of that section through the closing `}, 2000);` line with:

```js
  // ── 1. Init handshake ────────────────────────────────────────────
  // Symmetric handshake: the companion announces readiness immediately and
  // retries every 500ms until the parent posts `init` (with a transferable
  // MessagePort). This decouples init from the parent's iframe load-event
  // attachment timing — historically a race on cached page loads.
  // If retries exhaust without receiving init, post a companion_panic so
  // the parent at least surfaces a visible failure mode.

  const READY_RETRY_MS = 500;
  const READY_MAX_TRIES = 10;
  let readyTimer = null;
  let readyTries = 0;

  function postReady() {
    try {
      window.parent.postMessage({ type: 'companion_ready' }, '*');
    } catch (e) {
      // window.parent inaccessible (top-level page); nothing to do.
    }
  }

  function postPanic(reason) {
    try {
      window.parent.postMessage({ type: 'companion_panic', reason }, '*');
    } catch (e) {
      // best-effort
    }
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
        postPanic('init handshake exhausted retries');
        log.error('init handshake exhausted retries');
        return;
      }
      postReady();
    }, READY_RETRY_MS);
  }

  /** @type {((event: MessageEvent) => void) | null} */
  let onWindowMessage = (event) => {
    if (!event.ports || event.ports.length === 0) return;
    const incoming = event.data;
    if (!incoming || incoming.type !== 'init') return;

    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();

    if (readyTimer) {
      clearInterval(readyTimer);
      readyTimer = null;
    }

    if (Array.isArray(incoming.anchors)) {
      knownAnchors = incoming.anchors;
      log.info('init received, anchors:', knownAnchors.length);
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

- [ ] **Step 3: Update existing `log(...)` call sites to leveled form**

The previous `log()` was variadic and untyped. Walk the file and update each existing call to the appropriate level:

- Line near "init received, anchors:" → already updated above to `log.info` inside the handshake.
- Line near "init timeout" → removed (replaced by panic path).
- Line near "open_external attempted before init" → `log.warn('open_external attempted before init; dropping', url)`
- Line near "inbound" (`log('inbound', msg.type)`) → `log.info('inbound', msg.type)`
- Line near "unknown inbound" → `log.warn('unknown inbound', msg.type)`
- Line near "CSS Custom Highlight API not available" → `log.warn('CSS Custom Highlight API not available; text-range markers disabled')`

Verify by searching for `log(` in the file after edits:

```bash
grep -n 'log(' apps/api/src/companion/v1.js
```

Every match should be `log.info(...)`, `log.warn(...)`, or `log.error(...)`. The plain `log(level, ...)` form is the internal implementation; only the `.info/.warn/.error` callers should appear.

- [ ] **Step 4: Run companion route tests to catch regressions**

```bash
pnpm --filter @primer/api test -- src/routes/companion.test.ts
```

Expected: PASS. (These tests fetch the script; they don't execute it. So they verify only that the route still serves the file. Useful smoke for "did I accidentally break the route?")

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "$(cat <<'EOF'
fix(commenting): companion handshake retry + log streaming

Replaces the silent 2s init timeout with a bounded retry loop that
posts companion_ready every 500ms until the parent answers (max 10
tries), then emits companion_panic on exhaustion. Companion logs
now stream to the parent over the port so failures aren't trapped
behind the opaque-origin iframe console.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Companion caret-based click hit-test

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add `findTextRangeAtClick` helper**

In `apps/api/src/companion/v1.js`, locate the existing `findAnchorAtClick` function (around line 516). Just *above* it, add the new helper:

```js
  /**
   * Caret-based hit-test for text-range anchors. Uses the browser's own
   * caret-positioning logic (caretRangeFromPoint / caretPositionFromPoint)
   * and Range.comparePoint to decide which range — if any — contains the
   * click point. Overlapping ranges resolve to the smallest containing one.
   *
   * Returns the anchorId of the matching text-range anchor, or null.
   */
  function findTextRangeAtClick(event) {
    const x = event.clientX;
    const y = event.clientY;

    // Cheap reject: if no range's bounding box contains the click, skip the
    // caret lookup entirely. Bails out fast on the common case (click is
    // outside any highlight).
    let anyRectHit = false;
    outer: for (const range of rangeByAnchorId.values()) {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          anyRectHit = true;
          break outer;
        }
      }
    }
    if (!anyRectHit) return null;

    // Authoritative lookup via caret API.
    let caretNode = null;
    let caretOffset = 0;
    if (typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { caretNode = r.startContainer; caretOffset = r.startOffset; }
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { caretNode = p.offsetNode; caretOffset = p.offset; }
    }
    if (!caretNode) return null;

    let best = null;
    let bestLength = Infinity;
    for (const [anchorId, range] of rangeByAnchorId) {
      let inside = false;
      try {
        inside = range.comparePoint(caretNode, caretOffset) === 0;
      } catch (e) {
        // detached node — treat as miss
      }
      if (!inside) continue;
      const len = range.toString().length;
      if (len < bestLength) {
        best = anchorId;
        bestLength = len;
      }
    }
    return best;
  }
```

- [ ] **Step 2: Replace the text-range branch in `findAnchorAtClick`**

Still in `apps/api/src/companion/v1.js`, find the existing `findAnchorAtClick` function (still around line 516 area after Step 1's insertion). The function ends with the for-loop iterating `rangeByAnchorId` and doing rect math. Replace its entire body with:

```js
  function findAnchorAtClick(event) {
    // If the user just selected text by dragging, treat as selection capture,
    // not focus. (selection_captured fires on the same mouseup.)
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return null;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return null;

    // Pinned 💬 badge: matches its own data-anchor-id directly.
    const badge = target.closest('.__primer_badge__');
    if (badge instanceof HTMLElement && badge.dataset.anchorId) {
      return badge.dataset.anchorId;
    }

    // Element-path: check whether the click target is inside any tracked element.
    // Iterate the map; first match wins (these don't overlap in practice).
    for (const [anchorId, entry] of elementByAnchorId) {
      if (entry.el.contains(target)) return anchorId;
    }

    // Text-range: delegate to caret-based hit-test (more reliable than rects).
    return findTextRangeAtClick(event);
  }
```

The old point-in-rect loop is gone — the caret helper replaces it.

- [ ] **Step 3: Sanity-check the file still parses**

```bash
node --check apps/api/src/companion/v1.js
```

Expected: no output (silent success). Any syntax error prints to stderr.

- [ ] **Step 4: Run companion route tests**

```bash
pnpm --filter @primer/api test -- src/routes/companion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "$(cat <<'EOF'
fix(commenting): caret-based click hit-test for text-range anchors

Replaces brittle point-in-rect math with caretRangeFromPoint +
Range.comparePoint. Uses the browser's own caret-positioning logic
so the hit-test agrees with what the user perceives as "inside the
text." Overlapping anchors resolve deterministically to the smallest
containing range.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Stronger focused-thread styling

**Files:**
- Modify: `apps/web/src/components/ThreadCard.tsx`

- [ ] **Step 1: Edit the focused-class line**

In `apps/web/src/components/ThreadCard.tsx`, locate the `focusedClass` definition (around line 228):

```tsx
  const focusedClass = isFocused
    ? 'bg-yellow-50/40 dark:bg-amber-900/20 ring-1 ring-inset ring-yellow-200 dark:ring-amber-800'
    : '';
```

Replace with:

```tsx
  const focusedClass = isFocused
    ? 'bg-amber-100 dark:bg-amber-900/40 ring-2 ring-inset ring-amber-400 dark:ring-amber-600 shadow-sm'
    : '';
```

- [ ] **Step 2: Typecheck + tests**

```bash
pnpm --filter @primer/web typecheck && pnpm --filter @primer/web test
```

Expected: no errors. Tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ThreadCard.tsx
git commit -m "$(cat <<'EOF'
feat(web): stronger focused-thread treatment in sidebar

Replaces the near-invisible yellow-50/40 + ring-yellow-200 with a
saturated amber-100 background, 2px amber-400 inset ring, and small
shadow. Visible at a glance in light mode and distinguishable from
the quote-preview yellow bar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Verification (no commit)

**Files:** none modified.

- [ ] **Step 1: Workspace-wide typecheck**

```bash
pnpm -r typecheck
```

Expected: all packages PASS.

- [ ] **Step 2: Workspace-wide test suite**

```bash
pnpm -r test
```

Expected: all tests PASS, including the new ones from Tasks 1 and 2.

- [ ] **Step 3: Workspace-wide build**

```bash
pnpm -r build
```

Expected: all builds succeed.

- [ ] **Step 4: Manual smoke checklist (controller / human)**

The non-interactive subagent can't drive a browser, so this step is handed back to the human runner with the following checklist:

1. Start the dev server (whatever invocation the team uses — not `wrangler dev` per repo conventions; check `package.json` or recent commits).
2. Open `outpost-checklist.html` in Primer with at least two existing text-range comments and one element-path comment.
3. Hard-reload (Cmd-Shift-R) five times — highlights paint every time, click each one and confirm the sidebar focuses + scrolls the matching card into view.
4. Soft-reload (Cmd-R) five times — same result. *This is the cached-load case that exposed the original bug.*
5. Click a thread card in the sidebar — the iframe scrolls to the highlighted text and the focused amber outline shows on the card.
6. Open the host page's DevTools console — confirm `[companion] init received, anchors: N` and subsequent logs are streaming.
7. Select text in the iframe — the "Add comment in sidebar →" pill appears.
8. Switch to an older version of a document with comments — highlights paint on the new iframe.
9. Light-mode visual check: focused thread card is unmistakable against unfocused cards.
10. Dark-mode visual check: focused thread card is visibly distinct without overwhelming.
11. Repeat on at least one additional artifact the team has flagged as failing — confirm the fix generalizes.

- [ ] **Step 5: Report status**

If all automated checks passed and manual smoke is queued for the human: report DONE with commit list and the open manual-smoke item flagged. The runner is expected to push only after manual smoke greenlights (no-auto-push rule).
