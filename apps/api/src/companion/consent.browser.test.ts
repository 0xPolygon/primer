// REAL-BROWSER consent-gate tier (issue #78, security requirement 1).
//
// Run with `pnpm --filter @primer/api test:browser` (needs an installed
// Google Chrome; launched headless via playwright-core — no download).
//
// Why this tier exists: jsdom dispatches every event from JS via
// dispatchEvent(), so a whole dispatch shares one synchronous stack and
// microtasks never interleave between listeners. A real UA runs a microtask
// checkpoint after EVERY listener callback — a divergence that let a
// microtask-retired in-dispatch flag pass 18/18 jsdom tests while refusing
// 100% of legitimate submissions under genuine trusted input (local drill
// finding, 2026-08-26). The guarantees below are therefore proven ONLY
// here, against real CDP-trusted input in real Chrome:
//   - a submit dispatched synchronously in a genuine click's handler is
//     FORWARDED;
//   - a setTimeout-deferred submit is REFUSED (the deferral-laundering
//     window requirement 1 closes);
//   - an auto-fired submit with no gesture is REFUSED;
//   - one physical tap with greedy handlers on all five tap events yields
//     exactly ONE forward.
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const COMPANION_SOURCE = readFileSync(join(here, 'v1.js'), 'utf8');
// The exact shim the upload pipeline injects as head's first child.
const { EVENT_GUARD_SHIM_JS } = (await import('../upload/eventGuardShim.ts')) as {
  EVENT_GUARD_SHIM_JS: string;
};

// The probe artifact: inline scripts run BEFORE the companion (exactly like
// a real uploaded artifact), wiring buttons that submit synchronously, via
// setTimeout, via microtask, and greedily from every tap event.
// A page whose FIRST head script poisons Event.prototype.eventPhase — the
// vector adversarial round 5 found — BEFORE the guard shim + companion.
// Served at /poisoned.html WITH the guard shim injected ahead of the
// artifact script (mirroring the real upload pipeline: guard shim is head's
// first child), so this proves the shim defeats the poison. The poison
// attempt itself is wrapped so its throw (the shim already froze the
// getter) doesn't abort the rest of the artifact script.
const POISON_HEAD = `<script>try{Object.defineProperty(Event.prototype,'eventPhase',{configurable:true,get:function(){return 2;}});}catch(e){window.__poisonThrew=String(e&&e.name);}</script>`;

const PROBE_HTML = `<!doctype html><meta charset="utf-8"><title>consent probe</title>
<body>
<button id="send">send</button>
<button id="deferred">deferred</button>
<button id="micro">micro</button>
<button id="greedy">greedy</button>
<script>
  window.__forwarded = [];
  window.__results = [];
  window.addEventListener('primer:submit-result', (e) => { window.__results.push(e.detail); });
  let n = 0;
  window.__submit = function submit(tag) {
    window.dispatchEvent(new CustomEvent('primer:submit-events', {
      detail: { events: [{ namespace: 'padd', type: 'probe', audience: 'artifact', payload: { tag, n: ++n } }] },
    }));
  };
  document.getElementById('send').addEventListener('click', () => window.__submit('sync'));
  document.getElementById('deferred').addEventListener('click', () => setTimeout(() => window.__submit('timer'), 0));
  document.getElementById('micro').addEventListener('click', () => queueMicrotask(() => window.__submit('micro')));
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    document.getElementById('greedy').addEventListener(t, () => window.__submit('greedy:' + t));
  }
</script>
<script src="/companion/v1.js"></script>
</body>`;

let server: Server;
let baseUrl: string;
let browser: Browser;
let page: Page;

interface ProbeState {
  forwarded: { payload: { tag: string } }[][];
  results: { ok: boolean; error?: string }[];
}

async function readState(): Promise<ProbeState> {
  return page.evaluate(() => ({
    forwarded: (window as unknown as { __forwarded: ProbeState['forwarded'] }).__forwarded,
    results: (window as unknown as { __results: ProbeState['results'] }).__results,
  }));
}

async function settle(ms = 150): Promise<void> {
  await page.waitForTimeout(ms);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/companion/v1.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(COMPANION_SOURCE);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    const body = PROBE_HTML.replace(
      '<!doctype html><meta charset="utf-8"><title>consent probe</title>\n',
      '',
    );
    if ((req.url ?? '').startsWith('/poisoned-shimmed.html')) {
      // Guard shim as head's first child (pipeline order), THEN the
      // artifact's poison attempt, THEN the probe body + companion.
      res.end(`<!doctype html><head><script>${EVENT_GUARD_SHIM_JS}</script>${POISON_HEAD}</head>` + body);
      return;
    }
    if ((req.url ?? '').startsWith('/poisoned-unshimmed.html')) {
      // CONTROL: poison, NO guard shim — proves the vector is real and the
      // test discriminates (deferred submit forwards when unprotected).
      res.end(`<!doctype html><head>${POISON_HEAD}</head>` + body);
      return;
    }
    res.end(PROBE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Complete the init handshake exactly as the parent app does. At top level
// window.parent === window, so the companion's parent-source check
// deliberately passes (same as the app's own dev harness contexts).
async function initHandshake(): Promise<void> {
  await page.evaluate(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; events?: unknown[] };
      if (d && d.type === 'submit_events') {
        (window as unknown as { __forwarded: unknown[] }).__forwarded.push(d.events);
      }
    };
    channel.port1.start();
    window.postMessage({ type: 'init', anchors: [], theme: 'light' }, '*', [channel.port2]);
  });
}

beforeEach(async () => {
  await page.goto(`${baseUrl}/probe.html`);
  await initHandshake();
  await settle();
});

describe('consent gate under real UA input dispatch', () => {
  it('FORWARDS a submit dispatched synchronously inside a genuine click handler', async () => {
    await page.click('#send');
    await settle();
    const state = await readState();
    expect(state.forwarded).toHaveLength(1);
    expect(state.forwarded[0][0].payload.tag).toBe('sync');
    // No companion-level refusal fired for the legit path.
    expect(state.results.filter((r) => r.ok === false)).toHaveLength(0);
  });

  it('REFUSES a setTimeout-deferred submit riding a genuine click (the laundering window)', async () => {
    await page.click('#deferred');
    await settle(300);
    const state = await readState();
    expect(state.forwarded).toHaveLength(0);
    expect(state.results).toHaveLength(1);
    expect(state.results[0].ok).toBe(false);
    expect(state.results[0].error).toContain('consent_required');
  });

  it('REFUSES an auto-fired submit with no gesture at all', async () => {
    await page.evaluate(() => (window as unknown as { __submit: (t: string) => void }).__submit('autofire'));
    await settle();
    const state = await readState();
    expect(state.forwarded).toHaveLength(0);
    expect(state.results).toHaveLength(1);
    expect(state.results[0].error).toContain('consent_required');
  });

  it('one physical tap with greedy handlers on all five tap events yields exactly ONE forward', async () => {
    await page.click('#greedy');
    await settle();
    const state = await readState();
    expect(state.forwarded).toHaveLength(1);
    // The five handlers each attempted a submit: 1 forwarded + 4 refused.
    expect(state.results.filter((r) => r.ok === false)).toHaveLength(4);
    for (const r of state.results) expect(r.error).toContain('consent_required');
  });

  it('a second genuine tap is a fresh activation: two taps forward two submissions', async () => {
    await page.click('#send');
    await page.click('#send');
    await settle();
    const state = await readState();
    expect(state.forwarded).toHaveLength(2);
  });

  it('prototype-poisoning artifact CANNOT launder a deferred submit when the guard shim is present (defeats the round-5 vector)', async () => {
    await page.goto(`${baseUrl}/poisoned-shimmed.html`);
    await initHandshake();
    await settle();
    // Sanity: the artifact's poison attempt was rejected (the shim froze
    // the getter first, so the redefine threw).
    const poisonThrew = await page.evaluate(
      () => (window as unknown as { __poisonThrew?: string }).__poisonThrew,
    );
    expect(poisonThrew).toBe('TypeError');
    // The laundering attempt: a setTimeout-deferred submit riding a real
    // click. With the getter frozen, eventPhase reads its true NONE after
    // the dispatch ends → refused.
    await page.click('#deferred');
    await settle(300);
    const state = await readState();
    expect(state.forwarded).toHaveLength(0);
    expect(state.results).toHaveLength(1);
    expect(state.results[0].error).toContain('consent_required');
  });

  it('CONTROL: the same poison WITHOUT the shim does launder the deferred submit (vector is real, test discriminates)', async () => {
    await page.goto(`${baseUrl}/poisoned-unshimmed.html`);
    await initHandshake();
    await settle();
    await page.click('#deferred');
    await settle(300);
    const state = await readState();
    // Unprotected, eventPhase is pinned to 2 → the in-dispatch check passes
    // for a deferred submit → it forwards. This is exactly what the shim
    // prevents in the test above.
    expect(state.forwarded).toHaveLength(1);
  });

  it('microtask-deferred submit: never more than one forward per gesture (observed behavior pinned by the invariant, not the mechanism)', async () => {
    // A handler-queued microtask may run at the checkpoint after that
    // listener returns — the SAME gesture's dispatch may still be in
    // progress (forwarded, consuming the cluster) or already complete
    // (refused). Both uphold the security invariant: at most one
    // submission per physical activation, never a post-gesture window.
    await page.click('#micro');
    await settle(300);
    const state = await readState();
    expect(state.forwarded.length).toBeLessThanOrEqual(1);
    expect(state.forwarded.length + state.results.filter((r) => r.ok === false).length).toBe(1);
  });
});
