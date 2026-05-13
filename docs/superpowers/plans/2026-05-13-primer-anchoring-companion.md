# Primer Sub-Project 2 (Anchoring + Companion Script) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sub-project-1 companion stub with the real companion-script body, wire a typed parent↔iframe `MessageChannel` protocol, and stand up a dev-only test harness that exercises every protocol message end-to-end against a fixture artifact rendered through the real upload pipeline.

**Architecture:** Companion script (`/companion/v1.js`) is hand-written browser JS, ~10–15 KB, loaded into the sandboxed iframe; it accepts a transferred `MessagePort` from the parent at init and uses that single channel for everything afterward. The parent side is a thin typed wrapper (`apps/web/src/companion/client.ts`) plus an extended `ArtifactIframe` component that creates the channel on iframe load. Shared message types live in `@primer/shared/companion-protocol`. End-to-end testing happens through a new `/dev/harness` React page rendering a Hono-served fixture artifact.

**Tech Stack:** TypeScript 6 + Vite 8 + React 19 (parent side), hand-written browser JS (companion), Hono 4 (dev fixture route), Vitest 4 (added to `apps/web`), CSS Custom Highlight API (Chrome 105+/Safari 17.2+/Firefox 140+).

**Companion spec:** `docs/superpowers/specs/2026-05-13-primer-anchoring-companion-design.md`

---

## Pre-flight assumptions

- Working directory: `/home/taylan/development/polygon/primer`
- Branch: start from `master` (sub-project 1 is landed). Create a feature branch `feat/anchoring-companion` for this work.
- Postgres is up (`pnpm db:up` if not).
- `.env` exists at the repo root (sub-project 1 created it; `cp .env.example .env` if not).
- pnpm 11.1.0 is on PATH at `~/.local/bin/pnpm`; Node 24.13.0 is in the Nix store. Every Bash command starts with:
  ```bash
  export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
  ```
- SSH-key git signing is configured (no GPG prompt). Commits go on `feat/anchoring-companion` with normal `git commit` (no `--no-gpg-sign`, no author override).

---

## File map

```
apps/api/
  src/companion/
    v1.js                                  # REPLACED — full companion (was 3-line stub)
    fixtures/
      anchoring.html                       # NEW — checked-in fixture artifact
  src/routes/
    devFixture.ts                          # NEW — Hono dev route + ARTIFACT_CSP reuse
    devFixture.test.ts                     # NEW
  src/app.ts                               # MODIFIED — conditionally register dev route

packages/shared/
  src/companion-protocol.ts                # NEW — message types + parseInboundMessage
  src/index.ts                             # MODIFIED — barrel re-export

apps/web/
  vitest.config.ts                         # NEW — Vitest 4 node-mode config
  package.json                             # MODIFIED — vitest dev dep + test script
  src/companion/
    client.ts                              # NEW — typed parent-side helpers
    client.test.ts                         # NEW
    protocol.test.ts                       # NEW — parseInboundMessage tests
  src/components/
    ArtifactIframe.tsx                     # MODIFIED — accepts src/anchors/onMessage; opens MessageChannel
  src/routes/
    devHarness.tsx                         # NEW — /dev/harness page
    document.tsx                           # MODIFIED — adapt to new ArtifactIframe props
  src/App.tsx                              # MODIFIED — wires /dev/harness route
```

---

## Phase A — Test infrastructure

### Task 1: Add Vitest to `apps/web`

**Files:**
- Create: `apps/web/vitest.config.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Install Vitest as a dev dependency in `apps/web`**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web add -D vitest
```

Expected: lockfile updates; vitest resolves to a 4.x (matches the version `apps/api` already uses).

- [ ] **Step 2: Create the config**

File: `apps/web/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: { enabled: false },
  },
});
```

Pure functions only at the moment — `environment: 'node'` is fine. A future sub-project that needs DOM-based React testing will switch to `'jsdom'`.

- [ ] **Step 3: Update the test script**

In `apps/web/package.json`, replace the placeholder `test` script.

Before:
```json
"test": "echo 'no web tests in sub-project 1'"
```

After:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Confirm Vitest boots with zero tests cleanly**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web test
```

Expected: Vitest runs, reports "No test files found", exits 0. (Vitest 4 may exit non-zero on zero tests depending on config; if it does, a quick remedy is to add `passWithNoTests: true` to the config under `test:`.)

- [ ] **Step 5: Create the feature branch and commit**

```bash
cd /home/taylan/development/polygon/primer
git checkout -b feat/anchoring-companion
git add apps/web/package.json apps/web/vitest.config.ts pnpm-lock.yaml
git status
git commit -m "chore(web): add Vitest 4 node-mode for parent-side tests"
git log --oneline -3
```

---

## Phase B — Shared protocol package

### Task 2: Protocol types + `parseInboundMessage` (TDD)

**Files:**
- Create: `packages/shared/src/companion-protocol.ts`
- Modify: `packages/shared/src/index.ts` (re-export)
- Create: `apps/web/src/companion/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

The parser tests live in `apps/web` (Vitest just landed there in T1). They import the protocol from `@primer/shared`.

File: `apps/web/src/companion/protocol.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseInboundMessage } from '@primer/shared';

describe('parseInboundMessage', () => {
  it('round-trips selection_captured', () => {
    const ok = {
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText: 'hello',
        prefix: 'before-',
        suffix: '-after',
        containerPath: 'body > p:nth-of-type(1)',
      },
      clientRects: [{ x: 1, y: 2, width: 3, height: 4 }],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips element_picked', () => {
    const ok = {
      type: 'element_picked',
      anchor: {
        type: 'element-path',
        path: 'body > div:nth-of-type(1) > canvas:nth-of-type(1)',
        innerHash: '0123456789abcdef',
      },
      clientRect: { x: 10, y: 20, width: 200, height: 80 },
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips pick_mode_exited', () => {
    expect(parseInboundMessage({ type: 'pick_mode_exited' })).toEqual({
      type: 'pick_mode_exited',
    });
  });

  it('round-trips anchor_positions including drifted entries', () => {
    const ok = {
      type: 'anchor_positions',
      positions: [
        { anchorId: 'a1', rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
        { anchorId: 'a2', rects: [], drifted: true },
      ],
    };
    expect(parseInboundMessage(ok)).toEqual(ok);
  });

  it('round-trips resize', () => {
    expect(parseInboundMessage({ type: 'resize', height: 768 })).toEqual({
      type: 'resize',
      height: 768,
    });
  });

  it('round-trips open_external', () => {
    expect(parseInboundMessage({ type: 'open_external', url: 'https://example.com' })).toEqual({
      type: 'open_external',
      url: 'https://example.com',
    });
  });

  it('returns null for missing type', () => {
    expect(parseInboundMessage({ foo: 'bar' })).toBeNull();
  });

  it('returns null for unknown type', () => {
    expect(parseInboundMessage({ type: 'nope' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseInboundMessage('hello')).toBeNull();
    expect(parseInboundMessage(null)).toBeNull();
    expect(parseInboundMessage(undefined)).toBeNull();
    expect(parseInboundMessage(42)).toBeNull();
  });

  it('returns null for selection_captured with malformed anchor', () => {
    expect(
      parseInboundMessage({
        type: 'selection_captured',
        anchor: { type: 'text-range', selectorText: 'x' /* missing prefix/suffix/containerPath */ },
        clientRects: [],
      })
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web test protocol
```

Expected: fails because `parseInboundMessage` is not exported from `@primer/shared`.

- [ ] **Step 3: Implement the protocol module**

File: `packages/shared/src/companion-protocol.ts`

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
  prefix: string;
  suffix: string;
  containerPath: string;
}

export interface ElementPathAnchor {
  type: 'element-path';
  path: string;
  innerHash: string;
}

export type AnchorData = TextRangeAnchor | ElementPathAnchor;

export interface Anchor {
  id: string;
  data: AnchorData;
}

// Parent → Iframe
export interface MsgInit {
  type: 'init';
  anchors: Anchor[];
}
export interface MsgUpdateAnchors {
  type: 'update_anchors';
  anchors: Anchor[];
}
export interface MsgEnterPickMode {
  type: 'enter_pick_mode';
}
export interface MsgExitPickMode {
  type: 'exit_pick_mode';
}
export interface MsgHighlightAnchor {
  type: 'highlight_anchor';
  anchorId: string;
}
export interface MsgRequestAnchorPositions {
  type: 'request_anchor_positions';
}

export type OutboundProtocolMessage =
  | MsgInit
  | MsgUpdateAnchors
  | MsgEnterPickMode
  | MsgExitPickMode
  | MsgHighlightAnchor
  | MsgRequestAnchorPositions;

// Iframe → Parent
export interface MsgSelectionCaptured {
  type: 'selection_captured';
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}
export interface MsgElementPicked {
  type: 'element_picked';
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}
export interface MsgPickModeExited {
  type: 'pick_mode_exited';
}
export interface MsgAnchorPositions {
  type: 'anchor_positions';
  positions: { anchorId: string; rects: SerializableRect[]; drifted?: boolean }[];
}
export interface MsgResize {
  type: 'resize';
  height: number;
}
export interface MsgOpenExternal {
  type: 'open_external';
  url: string;
}

export type InboundProtocolMessage =
  | MsgSelectionCaptured
  | MsgElementPicked
  | MsgPickModeExited
  | MsgAnchorPositions
  | MsgResize
  | MsgOpenExternal;

// ───────────────────── Validation helpers ─────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRect(v: unknown): v is SerializableRect {
  return (
    isObject(v) &&
    isNumber(v.x) &&
    isNumber(v.y) &&
    isNumber(v.width) &&
    isNumber(v.height)
  );
}

function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
  return (
    isObject(v) &&
    v.type === 'text-range' &&
    isString(v.selectorText) &&
    isString(v.prefix) &&
    isString(v.suffix) &&
    isString(v.containerPath)
  );
}

function isElementPathAnchor(v: unknown): v is ElementPathAnchor {
  return (
    isObject(v) &&
    v.type === 'element-path' &&
    isString(v.path) &&
    isString(v.innerHash)
  );
}

export function parseInboundMessage(raw: unknown): InboundProtocolMessage | null {
  if (!isObject(raw) || !isString(raw.type)) return null;

  switch (raw.type) {
    case 'selection_captured': {
      if (!isTextRangeAnchor(raw.anchor)) return null;
      if (!Array.isArray(raw.clientRects) || !raw.clientRects.every(isRect)) return null;
      return {
        type: 'selection_captured',
        anchor: raw.anchor,
        clientRects: raw.clientRects,
      };
    }
    case 'element_picked': {
      if (!isElementPathAnchor(raw.anchor)) return null;
      if (!isRect(raw.clientRect)) return null;
      return { type: 'element_picked', anchor: raw.anchor, clientRect: raw.clientRect };
    }
    case 'pick_mode_exited':
      return { type: 'pick_mode_exited' };
    case 'anchor_positions': {
      if (!Array.isArray(raw.positions)) return null;
      const positions: MsgAnchorPositions['positions'] = [];
      for (const p of raw.positions) {
        if (!isObject(p) || !isString(p.anchorId)) return null;
        if (!Array.isArray(p.rects) || !p.rects.every(isRect)) return null;
        const entry: MsgAnchorPositions['positions'][number] = {
          anchorId: p.anchorId,
          rects: p.rects,
        };
        if (p.drifted === true) entry.drifted = true;
        positions.push(entry);
      }
      return { type: 'anchor_positions', positions };
    }
    case 'resize': {
      if (!isNumber(raw.height)) return null;
      return { type: 'resize', height: raw.height };
    }
    case 'open_external': {
      if (!isString(raw.url)) return null;
      return { type: 'open_external', url: raw.url };
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Re-export from the shared barrel**

Modify `packages/shared/src/index.ts`:

```ts
export * from './schema.ts';
export * from './storage.ts';
export * from './api.ts';
export * from './companion-protocol.ts';
```

- [ ] **Step 5: Run — verify pass**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web test protocol
pnpm --filter @primer/web typecheck
```

Expected: 10 passing tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src apps/web/src/companion/protocol.test.ts
git commit -m "feat(shared): companion protocol types + parseInboundMessage"
git log --oneline -3
```

---

## Phase C — Parent-side wrapper

### Task 3: `client.ts` — URL validator (TDD)

**Files:**
- Create: `apps/web/src/companion/client.ts`
- Create: `apps/web/src/companion/client.test.ts`

- [ ] **Step 1: Write the failing test**

File: `apps/web/src/companion/client.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { isSafeExternalUrl } from './client.ts';

describe('isSafeExternalUrl', () => {
  it('accepts well-formed https URLs', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('https://example.com/path?q=1#frag')).toBe(true);
  });

  it('rejects http URLs', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects relative URLs', () => {
    expect(isSafeExternalUrl('/relative/path')).toBe(false);
    expect(isSafeExternalUrl('relative')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web test client
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/web/src/companion/client.ts`

```ts
import type { MsgOpenExternal } from '@primer/shared';

export function isSafeExternalUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

export function handleOpenExternal(msg: MsgOpenExternal): void {
  if (!isSafeExternalUrl(msg.url)) {
    // eslint-disable-next-line no-console
    console.warn('[primer] rejected open_external', msg.url);
    return;
  }
  window.open(msg.url, '_blank', 'noopener,noreferrer');
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/web test client
pnpm --filter @primer/web typecheck
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/companion
git commit -m "feat(web): client.ts with isSafeExternalUrl + handleOpenExternal"
git log --oneline -3
```

---

### Task 4: Extend `ArtifactIframe` — accept `src` / `anchors` / `onMessage`, open MessageChannel

**Files:**
- Modify: `apps/web/src/components/ArtifactIframe.tsx`
- Modify: `apps/web/src/routes/document.tsx` (adapt to new prop)

- [ ] **Step 1: Replace `ArtifactIframe.tsx`**

File: `apps/web/src/components/ArtifactIframe.tsx`

```tsx
import { useEffect, useRef } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
} from '@primer/shared';
import { parseInboundMessage } from '@primer/shared';

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

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      const channel = new MessageChannel();
      const port = channel.port1;
      portRef.current = port;

      port.onmessage = (event) => {
        const parsed = parseInboundMessage(event.data);
        if (parsed) onMessage(parsed);
      };
      port.start();

      iframe.contentWindow?.postMessage(
        { type: 'init', anchors } satisfies OutboundProtocolMessage,
        '*',
        [channel.port2]
      );

      registerSender?.((msg) => port.postMessage(msg));
    };

    iframe.addEventListener('load', handleLoad);
    return () => {
      iframe.removeEventListener('load', handleLoad);
      portRef.current?.close();
      portRef.current = null;
      registerSender?.(null);
    };
    // We intentionally don't reset on `anchors` changes — anchors after init
    // travel through `update_anchors` via the imperative sender (see Task 14).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

- [ ] **Step 2: Adapt `document.tsx` to the new props**

Replace the `ArtifactIframe` call site in `apps/web/src/routes/document.tsx`. The `versionId` prop is gone; build the src URL at the call site. The other props are stubs for now — `DocumentPage` doesn't yet consume protocol messages (that's sub-project 3).

Modify `apps/web/src/routes/document.tsx`:

```tsx
import { useParams } from 'react-router-dom';
import { useDocument } from '../queries/documents.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';

export function DocumentPage() {
  const { docId } = useParams();
  const q = useDocument(docId ?? '');

  if (q.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (q.error) {
    return (
      <div className="text-red-600">
        Could not load document: {(q.error as Error).message}
      </div>
    );
  }
  if (!q.data) return null;

  const { document, latestVersion } = q.data;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between border-b border-neutral-200 pb-2">
        <div>
          <h1 className="text-xl font-semibold">{document.title}</h1>
          {document.description && (
            <p className="text-sm text-neutral-600">{document.description}</p>
          )}
        </div>
        <div className="text-sm text-neutral-500">
          {document.uploaderDisplayName} ·{' '}
          {new Date(document.createdAt).toLocaleString()}
        </div>
      </header>
      <ArtifactIframe
        src={`/api/versions/${latestVersion.id}/content`}
        anchors={[]}
        onMessage={() => {
          /* sub-project 3 wires the sidebar here */
        }}
      />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
```

Expected: clean. (No new tests in this task — `ArtifactIframe` is too DOM-dependent to easily unit-test without jsdom, and the harness in Phase F covers it.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): ArtifactIframe accepts src/anchors/onMessage, opens MessageChannel on iframe load"
git log --oneline -3
```

---

## Phase D — Companion script body

The companion is hand-written browser JS in a single IIFE in `apps/api/src/companion/v1.js`. Each task in this phase replaces or extends the file's contents to add one capability. Manual verification happens against the harness in Phase F — but you can also spot-check via DevTools by uploading any HTML doc through the existing UI and reading the iframe console.

### Task 5: Companion boot + init handshake

**Files:**
- Modify (replace fully): `apps/api/src/companion/v1.js`

- [ ] **Step 1: Replace the stub with the boot scaffold**

File: `apps/api/src/companion/v1.js`

```js
// Primer companion script v1.
// Loaded by the upload pipeline into every artifact iframe.
// Lives in the iframe (sandbox: allow-scripts allow-forms, opaque-origin "null").
// Talks to the parent ONLY via a MessageChannel port transferred at init.
(() => {
  /** @type {MessagePort | null} */
  let port = null;

  /** @type {{ id: string, data: any }[]} */
  let knownAnchors = [];

  /** @type {Set<string>} */
  const driftedIds = new Set();

  function log(...args) {
    // Cheap, namespaced. Cannot leak — the iframe console is opaque to the parent.
    // eslint-disable-next-line no-console
    console.log('[primer/companion]', ...args);
  }

  // ── 1. Init handshake ────────────────────────────────────────────
  // Wait for parent's init message. It carries a transferable port we keep.
  // After init we tear down the window-level listener; everything goes via the port.

  /** @type {((event: MessageEvent) => void) | null} */
  let onWindowMessage = (event) => {
    // Defensive: drop messages with no transferred port. We're only interested in init.
    if (!event.ports || event.ports.length === 0) return;
    const incoming = event.data;
    if (!incoming || incoming.type !== 'init') return;

    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();

    if (Array.isArray(incoming.anchors)) {
      knownAnchors = incoming.anchors;
      // Marker render arrives in Task 8/9. For now: log so the harness can see.
      log('init received, anchors:', knownAnchors.length);
    }

    if (onWindowMessage) {
      window.removeEventListener('message', onWindowMessage);
      onWindowMessage = null;
    }
  };

  window.addEventListener('message', onWindowMessage);

  // Bail out silently if init never arrives.
  setTimeout(() => {
    if (port === null) {
      log('init timeout (no parent or sandboxed harness without parent); standing down');
      if (onWindowMessage) {
        window.removeEventListener('message', onWindowMessage);
        onWindowMessage = null;
      }
    }
  }, 2000);

  // ── 2. Port message dispatcher ───────────────────────────────────
  function onPortMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    log('inbound', msg.type);

    switch (msg.type) {
      case 'update_anchors':
        if (Array.isArray(msg.anchors)) {
          knownAnchors = msg.anchors;
          driftedIds.clear();
          // marker re-render lands in Task 8/9
        }
        break;
      case 'enter_pick_mode':
        // Task 10
        break;
      case 'exit_pick_mode':
        // Task 10
        break;
      case 'highlight_anchor':
        // Task 8 (focused style)
        break;
      case 'request_anchor_positions':
        // Task 11
        break;
      default:
        log('unknown inbound', msg.type);
    }
  }

  // ── 3. Capability wiring (filled in by later tasks) ──────────────
  // Selection capture: Task 7
  // Marker rendering: Tasks 8, 9
  // Pick mode: Task 10
  // Position resolution + ResizeObserver: Task 11
  // External-nav forwarding: Task 6
})();
```

- [ ] **Step 2: Confirm the existing companion route + tests still pass**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test companion
```

Expected: the existing sub-project-1 companion route test still passes. It only checks `content-type`, `cache-control`, and that the body contains the phrase "companion v1 loaded". The new body uses the phrase `'[primer/companion]'` not `'companion v1 loaded'`. **Update the sub-project-1 test assertion** to match the new body. The test file is `apps/api/src/routes/companion.test.ts`.

Change the existing assertion:

Before:
```ts
expect(body).toContain('companion v1 loaded');
```

After:
```ts
expect(body).toContain('[primer/companion]'); // tag emitted by the v1 IIFE
```

Re-run:

```bash
pnpm --filter @primer/api test companion
```

Expected: still passing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/v1.js apps/api/src/routes/companion.test.ts
git commit -m "feat(api): companion v1 boot + init handshake (window→port handoff)"
git log --oneline -3
```

---

### Task 6: Companion — external-nav forwarding

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add the external-nav block inside the IIFE**

In `apps/api/src/companion/v1.js`, add the following helper + listener AFTER the `onPortMessage` function and BEFORE the closing `})();`. The override and click listener must install regardless of whether init succeeded — the artifact still benefits from "the link does what the user expects" even if the parent never set up a port.

```js
  // ── External-nav forwarding ──────────────────────────────────────
  // Sandbox without allow-popups silently kills window.open / target=_blank.
  // We intercept the two common paths and forward to the parent for opening.

  function postOpenExternal(url) {
    if (!port) {
      log('open_external attempted before init; dropping', url);
      return;
    }
    port.postMessage({ type: 'open_external', url });
  }

  // (a) anchor clicks with target="_blank" or "_top"
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const a = target.closest('a[target="_blank"], a[target="_top"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      // Resolve relative hrefs against the iframe document base.
      const resolved = new URL(href, document.baseURI).href;
      postOpenExternal(resolved);
    },
    true /* capture phase, so artifact handlers can't preempt us */
  );

  // (b) window.open() override.
  // The companion is `defer` + end-of-body, so this runs after all inline
  // artifact scripts. Artifacts that cached `window.open` early will miss
  // the override — that's a documented limitation (failure mode: link does
  // nothing, since the sandbox blocked it anyway).
  const _nativeOpen = window.open;
  window.open = function patchedOpen(url) {
    if (typeof url === 'string') postOpenExternal(url);
    return null; // mimic the sandbox-blocked behavior
  };
  // Silence "unused variable" without exposing the native to artifacts.
  void _nativeOpen;
```

- [ ] **Step 2: Confirm companion route still serves the file successfully**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test companion
```

Expected: passing (we're only modifying the file body; the route serves it via `readFile`).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(api): companion forwards external-nav via open_external (link + window.open)"
```

---

### Task 7: Companion — selection capture

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add helpers + selection capture inside the IIFE**

Add to `apps/api/src/companion/v1.js` (inside the IIFE, before the closing `})();`):

```js
  // ── Pure helpers used across capture / rendering ─────────────────

  const BLOCK_TAGS = new Set([
    'BODY','ARTICLE','SECTION','DIV','P',
    'H1','H2','H3','H4','H5','H6',
    'LI','TD','TH','BLOCKQUOTE','PRE','DETAILS',
  ]);

  function normalize(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function serializeRect(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function nearestBlockAncestor(node) {
    let el = node instanceof Element ? node : node.parentElement;
    while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el || document.body;
  }

  function cssPath(el) {
    if (el === document.body) return 'body';
    /** @type {string[]} */
    const parts = [];
    /** @type {Element | null} */
    let cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === cur.tagName
      );
      const nth = siblings.indexOf(cur) + 1;
      parts.push(siblings.length > 1 ? `${tag}:nth-of-type(${nth})` : tag);
      cur = parent;
    }
    parts.push('body');
    return parts.reverse().join(' > ');
  }

  /**
   * Walk text inside `container`, collect the normalized text up to and after the
   * selected range, return the trailing `n` chars before the range start and the
   * leading `n` chars after the range end.
   */
  function collectContext(container, range, n) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let beforeRaw = '';
    let afterRaw = '';
    let node = walker.nextNode();
    while (node) {
      if (node === range.startContainer) {
        beforeRaw += node.nodeValue.slice(0, range.startOffset);
        break;
      }
      // If the node is positioned before the start container in document order,
      // accumulate its full text into `beforeRaw`.
      const cmp = range.startContainer.compareDocumentPosition(node);
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) {
        beforeRaw += node.nodeValue;
      }
      node = walker.nextNode();
    }
    // Second pass for the trailing context.
    const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    node = walker2.nextNode();
    let foundEnd = false;
    while (node) {
      if (node === range.endContainer) {
        afterRaw += node.nodeValue.slice(range.endOffset);
        foundEnd = true;
      } else if (foundEnd) {
        afterRaw += node.nodeValue;
      }
      node = walker2.nextNode();
    }
    const beforeN = normalize(beforeRaw).slice(-n);
    const afterN = normalize(afterRaw).slice(0, n);
    return { prefix: beforeN, suffix: afterN };
  }

  // ── Selection capture ────────────────────────────────────────────

  let lastEmittedFingerprint = '';
  let lastEmittedAt = 0;

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

  document.addEventListener('mouseup', () => requestAnimationFrame(onPossibleSelection));
  document.addEventListener('keyup', () => requestAnimationFrame(onPossibleSelection));
```

- [ ] **Step 2: Sanity check the API tests are still green**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
```

Expected: 42/42 still passing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(api): companion captures selection on mouseup/keyup with normalized prefix/suffix"
```

---

### Task 8: Companion — text-range markers (CSS Custom Highlight API)

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add style block, highlights, and resolution logic**

Add to `apps/api/src/companion/v1.js` (inside the IIFE, before the closing `})();`). Wire it so:

- `update_anchors` (handled in T5's `onPortMessage`) now also calls `renderTextRangeMarkers()`.
- `highlight_anchor` switches a single anchor's range into the focused highlight for 1.5s.
- Init's anchors trigger a render once after they're stashed.

```js
  // ── Marker rendering: text-range ─────────────────────────────────
  // Uses CSS Custom Highlight API to paint highlights without mutating
  // the artifact DOM. Falls back to "no marker, mark drifted" when a
  // text-range can't be resolved.

  const STYLE_TAG_ID = '__primer_companion_style__';

  function ensureStyleTag() {
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_TAG_ID;
    style.setAttribute('data-primer', '1');
    style.textContent = `
      ::highlight(primer-mark)         { background: rgba(254, 240, 138, 0.6); }
      ::highlight(primer-mark-focused) { background: rgba(252, 211, 77, 0.9); }
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
      .__primer_pick_outline__ {
        position: absolute;
        outline: 2px solid rgba(59, 130, 246, 0.8);
        outline-offset: -2px;
        pointer-events: none;
      }
    `;
    document.head.insertBefore(style, document.head.firstChild);
  }

  /** Maintain two Highlight objects keyed by anchorId so we can switch between them. */
  let highlightDefault = null;
  let highlightFocused = null;
  function ensureHighlights() {
    if (!('Highlight' in window) || !window.CSS || !CSS.highlights) {
      log('CSS Custom Highlight API not available; text-range markers disabled');
      return false;
    }
    if (!highlightDefault) {
      highlightDefault = new Highlight();
      CSS.highlights.set('primer-mark', highlightDefault);
    }
    if (!highlightFocused) {
      highlightFocused = new Highlight();
      CSS.highlights.set('primer-mark-focused', highlightFocused);
    }
    return true;
  }

  /** anchorId → Range (for live anchors), so highlight_anchor can find the range. */
  const rangeByAnchorId = new Map();

  function resolveTextRange(anchor) {
    /** @type {Element | null} */
    let container;
    try {
      container = document.querySelector(anchor.containerPath);
    } catch {
      return null;
    }
    if (!container) return null;

    // Build a flat text buffer + a back-map from buffer offset to (textNode, offset).
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    /** @type {{ node: Text, start: number }[]} */
    const segs = [];
    let raw = '';
    let n = walker.nextNode();
    while (n) {
      segs.push({ node: /** @type {Text} */ (n), start: raw.length });
      raw += n.nodeValue;
      n = walker.nextNode();
    }

    const normalizedRaw = normalize(raw);
    const needle = normalize(anchor.prefix + anchor.selectorText + anchor.suffix);
    const hit = normalizedRaw.indexOf(needle);
    if (hit === -1) return null;

    // Find the raw offset corresponding to the start of selectorText.
    // We have to map the normalized hit back to a raw offset.
    const rawStart = mapNormalizedToRaw(raw, hit + normalize(anchor.prefix).length);
    const rawEnd = mapNormalizedToRaw(raw, hit + normalize(anchor.prefix).length + normalize(anchor.selectorText).length);
    if (rawStart < 0 || rawEnd < 0) return null;

    const start = locateInSegments(segs, rawStart);
    const end = locateInSegments(segs, rawEnd);
    if (!start || !end) return null;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function mapNormalizedToRaw(raw, normalizedOffset) {
    // Walk `raw`, counting normalized characters (single-space-collapsed,
    // leading whitespace dropped) until we hit the target offset.
    let i = 0;          // raw index
    let nIdx = 0;       // normalized index
    let seenNonWS = false;
    let inWS = false;
    while (i < raw.length && nIdx < normalizedOffset) {
      const ch = raw[i];
      const isWS = /\s/.test(ch);
      if (isWS) {
        if (seenNonWS && !inWS) {
          // Emits one space in the normalized form.
          nIdx++;
        }
        inWS = true;
      } else {
        seenNonWS = true;
        inWS = false;
        nIdx++;
      }
      i++;
    }
    return nIdx === normalizedOffset ? i : -1;
  }

  function locateInSegments(segs, rawOffset) {
    for (const seg of segs) {
      const end = seg.start + seg.node.nodeValue.length;
      if (rawOffset >= seg.start && rawOffset <= end) {
        return { node: seg.node, offset: rawOffset - seg.start };
      }
    }
    return null;
  }

  function renderTextRangeMarkers() {
    ensureStyleTag();
    if (!ensureHighlights()) return;

    highlightDefault.clear();
    highlightFocused.clear();
    rangeByAnchorId.clear();
    driftedIds.clear();

    for (const a of knownAnchors) {
      if (a.data.type !== 'text-range') continue;
      const range = resolveTextRange(a.data);
      if (!range) {
        driftedIds.add(a.id);
        continue;
      }
      rangeByAnchorId.set(a.id, range);
      highlightDefault.add(range);
    }
  }

  function applyFocusedHighlight(anchorId, durationMs) {
    const range = rangeByAnchorId.get(anchorId);
    if (!range) return;
    highlightDefault.delete(range);
    highlightFocused.add(range);
    try {
      const start = range.startContainer;
      const parentEl = start instanceof Element ? start : start.parentElement;
      parentEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {}
    setTimeout(() => {
      highlightFocused.delete(range);
      highlightDefault.add(range);
    }, durationMs);
  }
```

- [ ] **Step 2: Wire the new functions into the existing init/update handlers**

In the same file, locate the part of `onWindowMessage` that handles init (sets `knownAnchors`) and add a call:

```js
    if (Array.isArray(incoming.anchors)) {
      knownAnchors = incoming.anchors;
      log('init received, anchors:', knownAnchors.length);
      renderTextRangeMarkers();   // NEW
    }
```

And in `onPortMessage`, the `update_anchors` case:

```js
      case 'update_anchors':
        if (Array.isArray(msg.anchors)) {
          knownAnchors = msg.anchors;
          driftedIds.clear();
          renderTextRangeMarkers();   // NEW
        }
        break;
```

And the `highlight_anchor` case:

```js
      case 'highlight_anchor':
        if (typeof msg.anchorId === 'string') {
          applyFocusedHighlight(msg.anchorId, 1500);
        }
        break;
```

- [ ] **Step 3: Confirm the file still parses and existing tests still pass**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
```

Expected: 42/42 passing. (Companion routes test reads the file from disk; if there's a JS syntax error the file still serves, but you'd see a console error in the iframe at runtime.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(api): companion renders text-range markers via CSS Custom Highlight API"
```

---

### Task 9: Companion — element-pick badges (overlay layer)

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add overlay layer and element-pick rendering**

Append inside the IIFE, before the closing `})();`. This adds:
- One overlay `<div>` inserted into `<body>` (the only DOM mutation outside `<head>`).
- `sha256Hex` helper used for both anchor-rendering verification and (Task 10) element-pick capture.
- `renderElementBadges` function called from the same places `renderTextRangeMarkers` is called.

```js
  // ── Overlay layer + element-pick badges ──────────────────────────

  const OVERLAY_ID = '__primer_overlay__';

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.body.appendChild(overlay);
    return overlay;
  }

  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** anchorId → { el, badge } for currently-rendered element-path anchors. */
  const elementByAnchorId = new Map();

  async function renderElementBadges() {
    const overlay = ensureOverlay();
    ensureStyleTag();

    // Clear stale.
    for (const { badge } of elementByAnchorId.values()) {
      badge.remove();
    }
    elementByAnchorId.clear();

    for (const a of knownAnchors) {
      if (a.data.type !== 'element-path') continue;
      let el = null;
      try {
        el = document.querySelector(a.data.path);
      } catch {
        el = null;
      }
      if (!el) {
        driftedIds.add(a.id);
        continue;
      }
      const expected = a.data.innerHash;
      const actual = (await sha256Hex(normalize(el.textContent ?? ''))).slice(0, 16);
      if (actual !== expected) {
        driftedIds.add(a.id);
        continue;
      }
      const badge = document.createElement('div');
      badge.className = '__primer_badge__';
      badge.dataset.anchorId = a.id;
      badge.textContent = '💬';
      overlay.appendChild(badge);
      elementByAnchorId.set(a.id, { el, badge });
    }

    repositionElementBadges();
  }

  function repositionElementBadges() {
    for (const { el, badge } of elementByAnchorId.values()) {
      const rect = el.getBoundingClientRect();
      badge.style.left = `${rect.right + 4}px`;
      badge.style.top = `${rect.top}px`;
    }
  }
```

- [ ] **Step 2: Call `renderElementBadges` alongside `renderTextRangeMarkers`**

In the init-handling block and the `update_anchors` case, call both:

```js
      renderTextRangeMarkers();
      renderElementBadges();
```

(Fire and forget — `renderElementBadges` is async but we don't need to await it before continuing.)

In the `highlight_anchor` case, also update the badge for the focused anchor:

```js
      case 'highlight_anchor':
        if (typeof msg.anchorId === 'string') {
          applyFocusedHighlight(msg.anchorId, 1500);
          const entry = elementByAnchorId.get(msg.anchorId);
          if (entry) {
            entry.badge.classList.add('focused');
            try {
              entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch {}
            setTimeout(() => entry.badge.classList.remove('focused'), 1500);
          }
        }
        break;
```

- [ ] **Step 3: Sanity check**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
```

Expected: still 42/42 passing.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(api): companion renders element-pick badges in an overlay layer"
```

---

### Task 10: Companion — pick mode

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add pick-mode block inside the IIFE**

```js
  // ── Pick mode ────────────────────────────────────────────────────

  let pickActive = false;
  let pickOutline = null;
  let prevBodyCursor = '';

  function enterPickMode() {
    if (pickActive) return;
    pickActive = true;
    prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    pickOutline = document.createElement('div');
    pickOutline.className = '__primer_pick_outline__';
    ensureOverlay().appendChild(pickOutline);

    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
  }

  function exitPickMode(reason /* 'click' | 'esc' | 'parent' */) {
    if (!pickActive) return;
    pickActive = false;
    document.body.style.cursor = prevBodyCursor;
    pickOutline?.remove();
    pickOutline = null;

    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);

    if (reason === 'esc' && port) {
      port.postMessage({ type: 'pick_mode_exited' });
    }
  }

  let pickMoveQueued = false;
  function onPickMove(e) {
    if (pickMoveQueued) return;
    pickMoveQueued = true;
    requestAnimationFrame(() => {
      pickMoveQueued = false;
      if (!pickActive || !pickOutline) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const r = target.getBoundingClientRect();
      pickOutline.style.left = `${r.left}px`;
      pickOutline.style.top = `${r.top}px`;
      pickOutline.style.width = `${r.width}px`;
      pickOutline.style.height = `${r.height}px`;
    });
  }

  async function onPickClick(e) {
    if (!pickActive) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Don't let the artifact's own click handlers fire.
    e.preventDefault();
    e.stopImmediatePropagation();

    const path = cssPath(target);
    const innerHash = (await sha256Hex(normalize(target.textContent ?? ''))).slice(0, 16);
    const clientRect = serializeRect(target.getBoundingClientRect());

    exitPickMode('click');

    if (port) {
      port.postMessage({
        type: 'element_picked',
        anchor: { type: 'element-path', path, innerHash },
        clientRect,
      });
    }
  }

  function onPickKey(e) {
    if (!pickActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      exitPickMode('esc');
    }
  }
```

- [ ] **Step 2: Wire pick-mode commands into `onPortMessage`**

Replace the two pick-mode case stubs added in T5:

```js
      case 'enter_pick_mode':
        enterPickMode();
        break;
      case 'exit_pick_mode':
        exitPickMode('parent');
        break;
```

- [ ] **Step 3: Sanity check + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
```

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(api): companion implements pick mode (hover outline, click capture, Esc to cancel)"
```

---

### Task 11: Companion — position resolution + resize observer

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add position resolution and resize wiring**

```js
  // ── Anchor positions + resize ────────────────────────────────────

  function computeAnchorPositions() {
    /** @type {{ anchorId: string, rects: any[], drifted?: boolean }[]} */
    const out = [];
    for (const a of knownAnchors) {
      if (driftedIds.has(a.id)) {
        out.push({ anchorId: a.id, rects: [], drifted: true });
        continue;
      }
      if (a.data.type === 'text-range') {
        const range = rangeByAnchorId.get(a.id);
        if (!range) {
          out.push({ anchorId: a.id, rects: [], drifted: true });
          continue;
        }
        out.push({
          anchorId: a.id,
          rects: Array.from(range.getClientRects()).map(serializeRect),
        });
      } else {
        const entry = elementByAnchorId.get(a.id);
        if (!entry) {
          out.push({ anchorId: a.id, rects: [], drifted: true });
          continue;
        }
        out.push({
          anchorId: a.id,
          rects: [serializeRect(entry.el.getBoundingClientRect())],
        });
      }
    }
    return out;
  }

  // Wire in onPortMessage:
  //   case 'request_anchor_positions':
  //     port?.postMessage({ type: 'anchor_positions', positions: computeAnchorPositions() });
  //     break;

  // ── Resize observer ──────────────────────────────────────────────

  const ro = new ResizeObserver(() => {
    repositionElementBadges();
    if (port) {
      const h = document.documentElement.scrollHeight || document.body.scrollHeight;
      port.postMessage({ type: 'resize', height: h });
    }
  });
  ro.observe(document.body);
```

- [ ] **Step 2: Wire `request_anchor_positions` in `onPortMessage`**

Replace the stub case:

```js
      case 'request_anchor_positions':
        if (port) {
          port.postMessage({
            type: 'anchor_positions',
            positions: computeAnchorPositions(),
          });
        }
        break;
```

- [ ] **Step 3: Sanity check + commit**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
```

```bash
git add apps/api/src/companion/v1.js
git commit -m "feat(api): companion serves anchor_positions and emits resize on body changes"
```

---

## Phase E — Dev fixture + route

### Task 12: Fixture artifact HTML

**Files:**
- Create: `apps/api/src/companion/fixtures/anchoring.html`

- [ ] **Step 1: Create the fixture**

File: `apps/api/src/companion/fixtures/anchoring.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Primer anchoring fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; line-height: 1.5; padding: 24px; max-width: 720px; }
      h1 { margin-top: 0; }
      .row { display: flex; gap: 16px; align-items: center; margin: 16px 0; }
      .row > * + * { margin-left: 8px; }
      button { padding: 4px 10px; font: inherit; }
      canvas { border: 1px solid #ccc; }
      svg { display: block; }
    </style>
  </head>
  <body>
    <h1>Primer anchoring fixture</h1>
    <p>
      Lorem ipsum dolor sit amet, consectetur adipiscing elit. The quick brown
      fox jumps over the lazy dog. Select any of this text to capture an
      anchor. The harness should echo the captured anchor and let you save it.
    </p>
    <p>
      Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium
      doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore
      veritatis et quasi architecto beatae vitae dicta sunt explicabo. Highlight a
      saved anchor to see the focused style.
    </p>

    <div class="row">
      <a href="https://example.com/external" target="_blank" rel="noopener">External link (target=_blank)</a>
      <button onclick="window.open('https://example.com/popup')">Open https popup</button>
      <button onclick="window.open('http://example.com/bad')">Open http popup (should be rejected)</button>
    </div>

    <canvas id="demo-canvas" width="240" height="80"></canvas>

    <svg width="240" height="60" viewBox="0 0 240 60">
      <rect x="0"   y="0" width="40" height="40" fill="#fca5a5" />
      <rect x="60"  y="0" width="40" height="40" fill="#86efac" />
      <rect x="120" y="0" width="40" height="40" fill="#93c5fd" />
      <rect x="180" y="0" width="40" height="40" fill="#fde68a" />
    </svg>

    <button id="grow-btn" onclick="setTimeout(() => {
      const p = document.createElement('p');
      p.textContent = 'A paragraph appended 1s after the click.';
      document.body.appendChild(p);
    }, 1000);">Append a paragraph in 1 second</button>
  </body>
</html>
```

- [ ] **Step 2: Commit (no test yet; we wire the route in T13)**

```bash
git add apps/api/src/companion/fixtures/anchoring.html
git commit -m "feat(api): add anchoring test fixture HTML"
```

---

### Task 13: Hono dev fixture route + test + NODE_ENV gate

**Files:**
- Create: `apps/api/src/routes/devFixture.ts`
- Create: `apps/api/src/routes/devFixture.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

File: `apps/api/src/routes/devFixture.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { ARTIFACT_CSP } from './versionContent.ts';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'primer-devfixture-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('GET /dev/fixtures/anchoring.html', () => {
  it('serves the fixture with the locked artifact CSP when NODE_ENV is not production', async () => {
    delete process.env.NODE_ENV;
    const app = createApp({ storage: new FilesystemStorage(root) });
    const res = await app.request('/dev/fixtures/anchoring.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');

    const body = await res.text();
    expect(body).toContain('Primer anchoring fixture');
    expect(body).toContain('<script src="/companion/v1.js"');
    expect(body).not.toContain('<iframe'); // proves sanitize ran (fixture has none, but proves the pipe is alive)
  });

  it('is NOT registered when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const app = createApp({ storage: new FilesystemStorage(root) });
    const res = await app.request('/dev/fixtures/anchoring.html');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test devFixture
```

Expected: 404 on both cases (route not registered).

- [ ] **Step 3: Implement the route**

File: `apps/api/src/routes/devFixture.ts`

```ts
import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppVariables } from '../app.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { ARTIFACT_CSP } from './versionContent.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, '..', 'companion', 'fixtures', 'anchoring.html');

export function registerDevFixtureRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/dev/fixtures/anchoring.html', async (c) => {
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    const transformed = transformHtml(raw);
    if (!transformed.ok) {
      return c.json({ error: 'fixture_parse_failed', message: transformed.message }, 500);
    }
    return new Response(transformed.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ARTIFACT_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache',
      },
    });
  });
}
```

- [ ] **Step 4: Conditionally register in `app.ts`**

Modify `apps/api/src/app.ts`. Read the current state of the file first if needed; add the import and conditional registration after the existing route registrations:

```ts
// add at top of file with other imports
import { registerDevFixtureRoute } from './routes/devFixture.ts';
```

Then, after the existing route registrations inside `createApp`, before the `return app;`:

```ts
if (process.env.NODE_ENV !== 'production') {
  registerDevFixtureRoute(app);
}
```

- [ ] **Step 5: Run — verify pass**

```bash
pnpm --filter @primer/api test devFixture
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: dev fixture tests pass; total 44 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): dev fixture route registered behind NODE_ENV gate, runs through transformHtml + ARTIFACT_CSP"
```

---

## Phase F — Harness

### Task 14: `/dev/harness` page

**Files:**
- Create: `apps/web/src/routes/devHarness.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Build the harness page**

File: `apps/web/src/routes/devHarness.tsx`

```tsx
import { useCallback, useRef, useState } from 'react';
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  ElementPathAnchor,
  SerializableRect,
} from '@primer/shared';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';

interface LogEntry {
  ts: number;
  dir: 'in' | 'out';
  type: string;
  payload: unknown;
}

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

let synthSeq = 0;
function nextSynthId(): string {
  synthSeq += 1;
  return `harness-${Date.now()}-${synthSeq}`;
}

export function DevHarnessPage() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [pickMode, setPickMode] = useState(false);

  const senderRef = useRef<((msg: OutboundProtocolMessage) => void) | null>(null);

  const appendLog = useCallback((entry: LogEntry) => {
    setLog((l) => [entry, ...l].slice(0, 100));
  }, []);

  const send = useCallback(
    (msg: OutboundProtocolMessage) => {
      const s = senderRef.current;
      if (!s) {
        appendLog({ ts: Date.now(), dir: 'out', type: msg.type + ' (DROPPED — no port)', payload: msg });
        return;
      }
      s(msg);
      appendLog({ ts: Date.now(), dir: 'out', type: msg.type, payload: msg });
    },
    [appendLog]
  );

  const registerSender = useCallback(
    (s: ((msg: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
    },
    []
  );

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      appendLog({ ts: Date.now(), dir: 'in', type: msg.type, payload: msg });
      switch (msg.type) {
        case 'selection_captured':
          setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
          break;
        case 'element_picked':
          setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
          setPickMode(false);
          break;
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'open_external':
          if (!isSafeExternalUrl(msg.url)) {
            appendLog({
              ts: Date.now(),
              dir: 'in',
              type: 'open_external (REJECTED — non-https)',
              payload: msg,
            });
            return;
          }
          handleOpenExternal(msg);
          break;
        case 'resize':
        case 'anchor_positions':
          // Already logged above; no UI consequence in the harness.
          break;
      }
    },
    [appendLog]
  );

  const saveSelection = () => {
    if (!pendingSelection) return;
    const id = nextSynthId();
    const next = [...anchors, { id, data: pendingSelection.anchor }];
    setAnchors(next);
    setPendingSelection(null);
    send({ type: 'update_anchors', anchors: next });
  };

  const savePick = () => {
    if (!pendingPick) return;
    const id = nextSynthId();
    const next = [...anchors, { id, data: pendingPick.anchor }];
    setAnchors(next);
    setPendingPick(null);
    send({ type: 'update_anchors', anchors: next });
  };

  const dropAnchor = (id: string) => {
    const next = anchors.filter((a) => a.id !== id);
    setAnchors(next);
    send({ type: 'update_anchors', anchors: next });
  };

  const highlight = (id: string) => send({ type: 'highlight_anchor', anchorId: id });

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <ArtifactIframe
          src="/dev/fixtures/anchoring.html"
          anchors={anchors}
          onMessage={onMessage}
          registerSender={registerSender}
        />
      </div>
      <div className="space-y-4 overflow-y-auto" style={{ height: 'calc(100vh - 120px)' }}>
        <section>
          <h2 className="font-semibold mb-1">Current selection</h2>
          {pendingSelection ? (
            <div className="rounded border border-neutral-200 p-2">
              <pre className="text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(pendingSelection.anchor, null, 2)}
              </pre>
              <div className="mt-2 flex gap-2">
                <button onClick={saveSelection} className="rounded bg-neutral-900 px-3 py-1 text-white">
                  Save as anchor
                </button>
                <button onClick={() => setPendingSelection(null)} className="rounded border px-3 py-1">
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-neutral-500">No selection captured yet.</p>
          )}
        </section>

        <section>
          <h2 className="font-semibold mb-1">Saved anchors ({anchors.length})</h2>
          {anchors.length === 0 && <p className="text-sm text-neutral-500">None yet.</p>}
          <ul className="space-y-1">
            {anchors.map((a) => (
              <li key={a.id} className="rounded border border-neutral-200 p-2 text-xs">
                <div className="font-mono">
                  {a.id} — {a.data.type}
                </div>
                <div className="truncate text-neutral-600">
                  {a.data.type === 'text-range' ? `"${a.data.selectorText}"` : a.data.path}
                </div>
                <div className="mt-1 flex gap-2">
                  <button onClick={() => highlight(a.id)} className="rounded border px-2">
                    Highlight
                  </button>
                  <button onClick={() => dropAnchor(a.id)} className="rounded border px-2">
                    Drop
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="font-semibold mb-1">Pick mode</h2>
          <button
            onClick={togglePickMode}
            className={`rounded px-3 py-1 ${pickMode ? 'bg-red-600 text-white' : 'bg-neutral-900 text-white'}`}
          >
            {pickMode ? 'Exit pick mode' : 'Enter pick mode'}
          </button>
          {pendingPick && (
            <div className="mt-2 rounded border border-neutral-200 p-2">
              <pre className="text-xs whitespace-pre-wrap break-words">
                {JSON.stringify(pendingPick.anchor, null, 2)}
              </pre>
              <button onClick={savePick} className="mt-2 rounded bg-neutral-900 px-3 py-1 text-white">
                Save as anchor
              </button>
            </div>
          )}
        </section>

        <section>
          <h2 className="font-semibold mb-1">Message log</h2>
          <ul className="space-y-1">
            {log.map((e, i) => (
              <li key={i} className="rounded border border-neutral-200 p-1 text-xs">
                <span className="font-mono text-neutral-500">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>{' '}
                <span className="font-semibold">
                  {e.dir === 'in' ? '←' : '→'} {e.type}
                </span>
                <details>
                  <summary className="text-neutral-500">payload</summary>
                  <pre className="whitespace-pre-wrap break-words">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the route**

Modify `apps/web/src/App.tsx`. Add the import and a new route entry:

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './AppShell.tsx';
import { HomePage } from './routes/home.tsx';
import { UploadPage } from './routes/upload.tsx';
import { DocumentPage } from './routes/document.tsx';
import { DevHarnessPage } from './routes/devHarness.tsx';
import { NotFoundPage } from './routes/notFound.tsx';

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/upload', element: <UploadPage /> },
      { path: '/d/:docId', element: <DocumentPage /> },
      { path: '/dev/harness', element: <DevHarnessPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 3: Typecheck + boot**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
```

Expected: typecheck clean, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): /dev/harness page exercising the full companion protocol"
```

---

## Phase G — Verification

### Task 15: End-to-end exit-criteria walkthrough

**Files:** none — verification only.

- [ ] **Step 1: Start both processes from a clean shell**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm db:up
pnpm dev
```

Wait for both lines: "primer api listening port 3000" and "VITE … ready". Open `http://localhost:5173/dev/harness` in a real browser.

- [ ] **Step 2: Walk each EC manually**

For each, observe the behavior; record any deviation:

- **EC1** — Reload the page. DevTools (iframe console) shows `[primer/companion] init received, anchors: 0`.
- **EC2** — Select a sentence in the fixture. The "Current selection" pane shows the captured anchor with non-empty `prefix` and `suffix`. Resize fires too — that's fine.
- **EC3** — Click "Save as anchor". The selected text turns yellow inside the iframe.
- **EC4** — Click "Highlight" on the saved anchor. Color deepens for ~1.5s; iframe scrolls the anchor into view.
- **EC5** — Click the "External link (target=_blank)" anchor in the fixture. New browser tab opens to `https://example.com/external`.
- **EC6** — Click "Open https popup". New browser tab opens to `https://example.com/popup`.
- **EC7** — Click "Open http popup (should be rejected)". No new tab. Harness log shows a `open_external (REJECTED — non-https)` entry.
- **EC8** — Click "Enter pick mode". Cursor changes to crosshair inside the iframe. Hover any element → blue outline tracks it. Click the `<canvas>`. Pending pick pane shows the path + `innerHash`. Save it. Click "Enter pick mode" again, hover, press Esc — pick toggle returns to "Enter pick mode" and log shows `pick_mode_exited`.
- **EC9** — Manually edit a saved text-range anchor to have a nonsense `selectorText`. (Easiest: stop, drop it, save a new selection, then in DevTools React state, mutate `anchors[i].data.selectorText`.) Trigger a `request_anchor_positions` (DevTools console: `senderRef.current({type: 'request_anchor_positions'})` — or click highlight to indirectly trigger position computation). Log shows `drifted: true` for that anchor.
- **EC10** — Click "Append a paragraph in 1 second". ~1s later log shows a `resize` entry with a larger height.
- **EC11** — In a separate shell:
  ```bash
  pnpm verify
  ```
  Expected: typecheck + tests + audit all green.

- [ ] **Step 3: Any deviations → fix commits**

Apply targeted fixes, recommit with `fix:` prefix. Re-verify the affected EC.

- [ ] **Step 4: Final state confirmation**

```bash
git log --oneline master..HEAD | wc -l
git log --oneline -20
```

Expected: ~17 commits on the branch.

---

### Task 16: Finalize the branch

**Files:** none.

- [ ] **Step 1: Push and decide**

This plan stops at "ready for merge"; the user picks merge strategy. Suggested message back to them:

> "Sub-project 2 is implementation-complete. 17 commits on `feat/anchoring-companion`. All exit criteria verified through `/dev/harness`. Ready for squash-merge into master per the established pattern, or PR if you want pre-merge review."

---

## Notes for the implementer

- **The companion script is exempt from TDD** for this sub-project. It runs only in the browser; the test harness IS the integration test. Pure helpers inside it (`normalize`, `cssPath`, `collectContext`, `mapNormalizedToRaw`) get exercised end-to-end. If any one of them gets gnarly during implementation (especially `mapNormalizedToRaw`), feel free to extract it into a module and add Vitest coverage — that's a sub-project 3 concern by default but reasonable to do here if it saves debugging time.
- **CSS Custom Highlight API availability** — Chrome 105+, Safari 17.2+, Firefox 140+. If the harness shows `[primer/companion] CSS Custom Highlight API not available; text-range markers disabled` in the iframe console, the browser is too old. Polygon's desktop browsers should be modern enough; fallback isn't in scope.
- **Init timing** — the parent waits for the iframe's `load` event before sending init. The companion is `defer` + end-of-body, so by `load` time its window-level listener is registered. If you ever see the 2s init-timeout log line, something's wrong with the boot order (e.g., the parent never wired the listener), not with the companion.
- **`compareDocumentPosition` in `collectContext`** is the simplest correct way to know "is text node X before or after the selection's start container." There are TreeWalker tricks that avoid it, but they're brittle. Keep it.
- **Don't move the `<style>` element** — it's prepended to `<head>` deliberately so that artifact-author stylesheets can override our highlights' colors if they want (`!important` or later in the cascade). Default-color clashes with the artifact aren't a defect; they're a "user can opt out" feature.
- **`registerSender` prop on ArtifactIframe** is intentionally a callback rather than a ref so the parent can clean up on unmount. The harness uses `senderRef.current`; production callers in sub-project 3 will use the same pattern.
