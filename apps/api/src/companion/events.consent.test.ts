// @vitest-environment jsdom
//
// Consent gate + submit/read relay for document events (issue #78), tested
// against the REAL companion: v1.js is evaluated into this jsdom window and
// the init handshake performed with a genuine MessageChannel, so these tests
// exercise the actual gate — not a mirror.
//
// The load-bearing property (issue #78 security requirement 1): the
// companion relays `primer:submit-events` ONLY from within the same trusted
// event dispatch that carried the user gesture — transient activation
// consumed in-dispatch. Checking navigator.userActivation.isActive alone
// would leave an activation-laundering window (defer the dispatch into the
// activation window of an unrelated click); these tests close over exactly
// that: (a) an auto-fired event on load is refused, (b) a dispatch deferred
// into the activation window of an unrelated click is refused, and a
// gesture, once used, is consumed — one gesture, one submission.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const COMPANION_SOURCE = readFileSync(join(here, 'v1.js'), 'utf8');

/** Messages the companion posted to the parent over the port. */
const portInbox: { type: string; [k: string]: unknown }[] = [];
/** The parent's half of the channel — post into the companion with it. */
let parentPort!: MessagePort;

// jsdom cannot mint trusted events (isTrusted is a non-configurable accessor
// that dispatchEvent resets to false — that's the point of the bit). To test
// the REAL gate we flip the event's webidl2js impl slot from a capture
// listener registered BEFORE the companion loads, so it runs ahead of the
// companion's own capture listeners in the same phase. Only events explicitly
// marked by dispatchTrusted() are flipped.
const TEST_TRUSTED = Symbol('test-trusted');

function flipTrusted(event: Event): void {
  if (!(event as unknown as Record<symbol, unknown>)[TEST_TRUSTED]) return;
  for (const sym of Object.getOwnPropertySymbols(event)) {
    const impl = (event as unknown as Record<symbol, unknown>)[sym];
    if (impl && typeof impl === 'object' && 'isTrusted' in (impl as object)) {
      (impl as { isTrusted: boolean }).isTrusted = true;
    }
  }
}

function dispatchTrusted(target: EventTarget, event: Event): void {
  (event as unknown as Record<symbol, unknown>)[TEST_TRUSTED] = true;
  target.dispatchEvent(event);
}

/** Waits until queued port messages / microtasks have drained. MessagePort
 *  delivery is task-scheduled and occasionally needs more than one turn, so
 *  drain several macrotasks. */
async function tick(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Polls until `cond` holds (or times out — the caller's assertion then
 *  reports the actual state). For positive delivery expectations. */
async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface SubmitResultDetail {
  ok: boolean;
  rows?: unknown[];
  error?: string;
}

const submitResults: SubmitResultDetail[] = [];
const relayedBatches: unknown[][] = [];

const VALID_EVENT = {
  namespace: 'padd',
  type: 'export',
  payload: { verdict: 'approve' },
  audience: 'artifact',
};

function dispatchSubmit(events: unknown[] = [VALID_EVENT]): void {
  window.dispatchEvent(new CustomEvent('primer:submit-events', { detail: { events } }));
}

beforeAll(async () => {
  // v1.js expects browser APIs jsdom doesn't ship.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };

  // The artifact-side observers under test.
  window.addEventListener('primer:submit-result', (e) => {
    submitResults.push((e as CustomEvent<SubmitResultDetail>).detail);
  });
  window.addEventListener('primer:events', (e) => {
    relayedBatches.push((e as CustomEvent<{ events: unknown[] }>).detail.events);
  });

  // Trust patcher — MUST be registered before the companion so it runs
  // first in the capture phase for the same targets.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'touchstart', 'touchend']) {
    window.addEventListener(type, flipTrusted, true);
  }

  // Load the real companion.
  (0, eval)(COMPANION_SOURCE);

  // Complete the init handshake with a real MessageChannel, exactly as the
  // parent's ArtifactIframe does.
  const channel = new MessageChannel();
  parentPort = channel.port1;
  parentPort.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string };
    if (data && typeof data.type === 'string') {
      portInbox.push(data as { type: string });
    }
  };
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'init', anchors: [], theme: 'light' },
      ports: [channel.port2],
    }),
  );
  await tick();
});

beforeEach(() => {
  // Settle the companion's activation-cluster state to "between
  // interactions": a full trusted keystroke (press + release) both retires
  // any lingering consumed cluster from the previous test and leaves
  // releaseSeen=true so each test's first press mints a fresh cluster.
  // (Tests that dispatch a bare `click` — a release-family event, which by
  // design never re-mints — continue this fresh, unconsumed cluster, just
  // as a real click continues its own preceding pointerdown's cluster.)
  dispatchTrusted(window, new KeyboardEvent('keydown', { key: 'Shift' }));
  dispatchTrusted(window, new KeyboardEvent('keyup', { key: 'Shift' }));
  portInbox.length = 0;
  submitResults.length = 0;
  relayedBatches.length = 0;
});

function forwardedSubmits(): { type: string; events?: unknown[] }[] {
  return portInbox.filter((m) => m.type === 'submit_events');
}

describe('consent gate — activation consumed in-dispatch', () => {
  it('(a) refuses an auto-fired submit with no user gesture at all', async () => {
    dispatchSubmit();
    await tick();
    expect(forwardedSubmits()).toHaveLength(0);
    expect(submitResults).toHaveLength(1);
    expect(submitResults[0].ok).toBe(false);
    expect(submitResults[0].error).toContain('consent_required');
  });

  it('(b) refuses a dispatch deferred (macrotask) into the activation window of an unrelated click', async () => {
    // The artifact schedules its submit from a trusted click handler — but
    // asynchronously, i.e. after the trusted dispatch has left the stack.
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.addEventListener('click', () => {
      setTimeout(() => dispatchSubmit(), 0);
    });
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    await tick();
    await tick();
    expect(forwardedSubmits()).toHaveLength(0);
    expect(submitResults).toHaveLength(1);
    expect(submitResults[0].error).toContain('consent_required');
  });

  it('(b′) refuses a microtask-deferred dispatch too — the token retires before artifact microtasks run', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.addEventListener('click', () => {
      queueMicrotask(() => dispatchSubmit());
    });
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(forwardedSubmits()).toHaveLength(0);
    expect(submitResults).toHaveLength(1);
    expect(submitResults[0].error).toContain('consent_required');
  });

  it('refuses a dispatch riding an UNTRUSTED (synthetic) click', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.addEventListener('click', () => dispatchSubmit());
    // No makeTrusted — a synthetic click mints no token.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(forwardedSubmits()).toHaveLength(0);
    expect(submitResults[0]?.error).toContain('consent_required');
  });

  it('forwards a submit dispatched synchronously within a trusted click dispatch', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.addEventListener('click', () => dispatchSubmit());
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    await waitUntil(() => forwardedSubmits().length >= 1);
    const forwarded = forwardedSubmits();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].events).toEqual([VALID_EVENT]);
    // The companion's own refusal ack must NOT fire on success (the real
    // ack comes from the parent as submit_result after the POST).
    expect(submitResults).toHaveLength(0);
  });

  it('consumes the activation: one gesture authorizes exactly one submission', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.addEventListener('click', () => {
      dispatchSubmit([{ ...VALID_EVENT, payload: { n: 1 } }]);
      dispatchSubmit([{ ...VALID_EVENT, payload: { n: 2 } }]); // same dispatch — must be refused
    });
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    await waitUntil(() => forwardedSubmits().length >= 1);
    const forwarded = forwardedSubmits();
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0].events as { payload: { n: number } }[])[0].payload).toEqual({ n: 1 });
    expect(submitResults).toHaveLength(1);
    expect(submitResults[0].error).toContain('consent_required');
  });
});

describe('submit validation (companion pre-check; server re-validates)', () => {
  function submitWithinGesture(events: unknown[]): void {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.addEventListener('click', () => dispatchSubmit(events));
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
  }

  it('refuses events missing audience, bad namespace/type, or oversized payloads', async () => {
    const cases: unknown[][] = [
      [{ namespace: 'padd', type: 'export', payload: {} }], // no audience
      [{ ...VALID_EVENT, namespace: 'Padd' }],
      [{ ...VALID_EVENT, type: 'a/b' }],
      [{ ...VALID_EVENT, payload: { big: 'x'.repeat(256 * 1024) } }],
      [],
    ];
    for (const events of cases) {
      submitWithinGesture(events);
      await tick();
    }
    expect(forwardedSubmits()).toHaveLength(0);
    expect(submitResults).toHaveLength(cases.length);
    for (const r of submitResults) expect(r.ok).toBe(false);
  });

  it('accepts a multi-event batch and forwards it verbatim (one port message)', async () => {
    submitWithinGesture([
      { namespace: 'padd', type: 'verdict', payload: { id: 'a' }, audience: 'artifact' },
      { namespace: 'padd/telemetry', type: 'grant', payload: null, audience: 'author' },
    ]);
    await waitUntil(() => forwardedSubmits().length >= 1);
    const forwarded = forwardedSubmits();
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].events).toHaveLength(2);
  });
});

describe('read relay + write ack into the artifact', () => {
  it('re-dispatches port `events` batches as primer:events with detail.events', async () => {
    const rows = [
      { id: 7, documentId: 'd', authorId: 'u', audience: 'artifact', namespace: 'padd', type: 'export', payload: {}, createdAt: 'now' },
      { id: 9, documentId: 'd', authorId: 'u', audience: 'artifact', namespace: 'padd', type: 'verdict', payload: {}, createdAt: 'now' },
    ];
    parentPort.postMessage({ type: 'events', events: rows });
    await tick();
    expect(relayedBatches).toHaveLength(1);
    expect(relayedBatches[0]).toEqual(rows);
  });

  it('re-dispatches port `submit_result` as primer:submit-result with the created rows', async () => {
    const rows = [{ id: 12, namespace: 'padd', type: 'export' }];
    parentPort.postMessage({ type: 'submit_result', ok: true, rows });
    await tick();
    expect(submitResults).toHaveLength(1);
    expect(submitResults[0]).toEqual({ ok: true, rows, error: undefined });
  });
});


describe('activation clusters — one physical interaction, at most one submission', () => {
  /** A button whose handler on EVERY listed event type dispatches a submit
   *  with a distinguishing payload — the adversarial artifact shape. */
  function makeGreedyButton(types: string[]): HTMLButtonElement {
    const button = document.createElement('button');
    document.body.appendChild(button);
    for (const type of types) {
      button.addEventListener(type, () => {
        dispatchSubmit([{ ...VALID_EVENT, payload: { firedOn: type } }]);
      });
    }
    return button;
  }

  it('one mouse tap (pointerdown→mousedown→pointerup→mouseup→click, submit in every handler) forwards exactly ONE submission', async () => {
    const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const button = makeGreedyButton(types);
    dispatchTrusted(button, new MouseEvent('pointerdown', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('mousedown', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('pointerup', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('mouseup', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    await waitUntil(() => forwardedSubmits().length >= 1);
    const forwarded = forwardedSubmits();
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0].events as { payload: { firedOn: string } }[])[0].payload.firedOn).toBe('pointerdown');
    // The other four handlers were refused.
    expect(submitResults).toHaveLength(4);
    for (const r of submitResults) expect(r.error).toContain('consent_required');
  });

  it('a second tap mints a fresh cluster: two taps forward two submissions', async () => {
    const button = makeGreedyButton(['pointerdown', 'click']);
    for (let tap = 0; tap < 2; tap++) {
      dispatchTrusted(button, new MouseEvent('pointerdown', { bubbles: true }));
      dispatchTrusted(button, new MouseEvent('pointerup', { bubbles: true }));
      dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    }
    await waitUntil(() => forwardedSubmits().length >= 2);
    expect(forwardedSubmits()).toHaveLength(2);
  });

  it('one touch tap including the compatibility mouse replay forwards exactly ONE submission', async () => {
    const button = makeGreedyButton(['touchstart', 'mousedown', 'click']);
    // UA order for a tap on a touch device: pointer events, touch events,
    // then the compatibility mouse burst replaying the same tap.
    dispatchTrusted(button, new MouseEvent('pointerdown', { bubbles: true }));
    dispatchTrusted(button, new Event('touchstart', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('pointerup', { bubbles: true }));
    dispatchTrusted(button, new Event('touchend', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('mousedown', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('mouseup', { bubbles: true }));
    dispatchTrusted(button, new MouseEvent('click', { bubbles: true }));
    await waitUntil(() => forwardedSubmits().length >= 1);
    const forwarded = forwardedSubmits();
    expect(forwarded).toHaveLength(1);
    expect((forwarded[0].events as { payload: { firedOn: string } }[])[0].payload.firedOn).toBe('touchstart');
  });

  it('a held key (keydown auto-repeat) is ONE activation cluster', async () => {
    const button = makeGreedyButton(['keydown']);
    dispatchTrusted(button, new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    dispatchTrusted(button, new KeyboardEvent('keydown', { bubbles: true, key: 'a', repeat: true }));
    dispatchTrusted(button, new KeyboardEvent('keydown', { bubbles: true, key: 'a', repeat: true }));
    dispatchTrusted(button, new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    await waitUntil(() => forwardedSubmits().length >= 1);
    expect(forwardedSubmits()).toHaveLength(1);
    expect(submitResults).toHaveLength(2);
  });

  it('10 discrete keystrokes are 10 clusters — at most one submission per keydown..keyup pair', async () => {
    const button = makeGreedyButton(['keydown', 'keyup']);
    for (let i = 0; i < 10; i++) {
      dispatchTrusted(button, new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
      dispatchTrusted(button, new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    }
    await waitUntil(() => forwardedSubmits().length >= 10);
    // Each pair: keydown handler submit accepted, keyup handler submit
    // refused (cluster already consumed) — never two per keystroke.
    expect(forwardedSubmits()).toHaveLength(10);
    expect(submitResults).toHaveLength(10);
    for (const r of submitResults) expect(r.error).toContain('consent_required');
  });
});

describe('source ties (fail loudly if the gate is edited away)', () => {
  it('v1.js still consumes one activation cluster per physical interaction, in-dispatch, and never trusts userActivation.isActive', () => {
    expect(COMPANION_SOURCE).toContain("window.addEventListener('primer:submit-events'");
    expect(COMPANION_SOURCE).toContain('activationCluster.consumed = true');
    expect(COMPANION_SOURCE).toContain('releaseSeenSinceMint');
    expect(COMPANION_SOURCE).toContain('compatMousePending');
    expect(COMPANION_SOURCE).toContain('queueMicrotask');
    expect(COMPANION_SOURCE).not.toContain('userActivation.isActive)');
  });

  it('v1.js accepts init only from the embedding parent when actually embedded', () => {
    expect(COMPANION_SOURCE).toContain(
      'if (window.parent !== window && event.source !== window.parent) return;',
    );
  });

  it('v1.js validation limits mirror the api-types wire contract', () => {
    expect(COMPANION_SOURCE).toContain('/^[a-z0-9][a-z0-9-]*(\\/[a-z0-9][a-z0-9-]*)*$/');
    expect(COMPANION_SOURCE).toContain('256 * 1024');
  });
});
