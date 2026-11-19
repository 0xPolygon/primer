// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { LiveProvider } from './provider.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A provider that never connects: the editor binds to its Y.Doc as it would
// to a synced one.
vi.mock('./provider.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provider.ts')>()),
  createLiveProvider: (documentId: string): LiveProvider => {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: new HocuspocusProviderWebsocket({ url: 'ws://127.0.0.1:9/collab', autoConnect: false }),
      name: `doc:${documentId}`,
      document: doc,
    });
    return { provider, doc, destroy: () => provider.destroy() };
  },
}));

// jsdom lacks these; BlockNote's menus measure the page.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(check()).toBe(true);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
});

describe('LiveEditor', () => {
  it('live document renders the editor and legacy renders the iframe', async () => {
    const { DocumentSurface } = await import('../routes/document.tsx');
    const frame = () => createElement('iframe', { title: 'legacy-frame' });
    const props = { documentId: 'doc-1', readOnly: false, theme: 'light' as const, userName: 'Ana', frame };

    const live = await render(createElement(DocumentSurface, { ...props, live: true }));
    await until(() => live.querySelector('[contenteditable="true"].bn-editor') !== null);
    expect(live.querySelector('iframe[title="legacy-frame"]')).toBeNull();
    expect(live.textContent).toContain('History');
    await act(async () => root!.unmount());

    const legacy = await render(createElement(DocumentSurface, { ...props, live: false }));
    expect(legacy.querySelector('iframe[title="legacy-frame"]')).not.toBeNull();
    expect(legacy.querySelector('.bn-editor')).toBeNull();
  });

  it('connection indicator shows reconnecting, unsaved and save-failed states', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { ConnectionStatus } = await import('./ConnectionStatus.tsx');
    const handlers = new Map<string, ((data: never) => void)[]>();
    const connect = vi.fn();
    const provider = {
      on: (event: string, fn: (data: never) => void) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
      off: () => undefined,
      connect,
    };
    const emit = (event: string, data: unknown) => act(() => handlers.get(event)!.forEach((fn) => fn(data as never)));
    const el = await render(createElement(ConnectionStatus, { provider: provider as never }));
    const shown = () => el.querySelector('[role="status"]')?.getAttribute('data-connection') ?? 'ok';

    expect(shown()).toBe('reconnecting');
    await emit('status', { status: 'connected' });
    expect(shown()).toBe('ok');

    // Unacknowledged changes are only "unsaved" after five seconds.
    await emit('unsyncedChanges', { number: 2 });
    expect(shown()).toBe('ok');
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(shown()).toBe('unsaved');
    expect(el.textContent).toContain('Unsaved changes');
    await emit('unsyncedChanges', { number: 0 });
    expect(shown()).toBe('ok');

    await emit('status', { status: 'disconnected' });
    expect(el.textContent).toContain('Reconnecting…');

    // The server couldn't store an update: say so, and offer to retry.
    await emit('close', { event: { code: 4500 } });
    expect(shown()).toBe('save-failed');
    expect(el.textContent).toContain('Changes not saved');
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    expect(connect).toHaveBeenCalled();
    expect(shown()).toBe('reconnecting');
  });
});
