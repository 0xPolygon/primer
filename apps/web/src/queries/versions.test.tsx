// @vitest-environment jsdom
//
// Publishing a new version from the document page awaits the add-version
// mutation and then navigates to /d/:docId. That page latches the newest
// version in the cached list on its first render (lib/viewedVersion.ts). If
// the mutation resolves before the version list has been refreshed, the latch
// lands on the OLD latest, and when the refresh arrives the publisher is shown
// a "newer version was published" notice about their own upload.
//
// This drives the real hooks against a fake server and reproduces exactly
// what AddVersionModal does: await mutateAsync, then let the next page render
// latch from whatever the cache holds at that moment.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VersionSummaryDTO, VersionsListResponse } from '@polygonlabs/primer-api-types';
import { useAddVersion, useVersionsQuery } from './versions.ts';
import { nextLatch } from '../lib/viewedVersion.ts';

// React 19 warns unless the test environment says it uses act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = 'doc-1';
const LIST_DELAY_MS = 50; // the version-list refetch takes a moment, as it does over a network

const version = (n: number): VersionSummaryDTO => ({
  id: `v-${n}`,
  versionNumber: n,
  versionNote: null,
  sizeBytes: 10,
  createdAt: new Date(2026, 0, n).toISOString(),
});

let serverVersions: VersionSummaryDTO[] = [];
const realFetch = globalThis.fetch;

function installFakeServer(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith(`/api/documents/${DOC}/versions`) && method === 'GET') {
      const body: VersionsListResponse = { versions: [...serverVersions] };
      await new Promise((resolve) => setTimeout(resolve, LIST_DELAY_MS));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith(`/api/documents/${DOC}/versions`) && method === 'POST') {
      const next = version((serverVersions[0]?.versionNumber ?? 0) + 1);
      serverVersions = [next, ...serverVersions];
      return new Response(JSON.stringify({ versionId: next.id, versionNumber: next.versionNumber, url: `/d/${DOC}` }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

interface Hooks {
  addVersion: ReturnType<typeof useAddVersion>;
}

function Harness({ out }: { out: { current: Hooks | null } }) {
  useVersionsQuery(DOC);
  out.current = { addVersion: useAddVersion(DOC) };
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  serverVersions = [version(1)];
  installFakeServer();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

describe('publishing a new version from the document page', () => {
  it('lands the publisher on their new version, with no "newer version" notice about their own upload', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hooks: { current: Hooks | null } = { current: null };
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness, { out: hooks })));
    });
    const cachedList = () => qc.getQueryData<VersionsListResponse>(['versions', DOC])?.versions ?? [];
    await waitUntil(() => cachedList().length === 1);

    // AddVersionModal.submit: await the mutation, then navigate to /d/:docId.
    const current = hooks.current;
    if (!current) throw new Error('hooks not mounted');
    let published = 0;
    await act(async () => {
      const res = await current.addVersion.mutateAsync({
        file: new File(['<p>v2</p>'], 'v2.html', { type: 'text/html' }),
        versionNote: null,
      });
      published = res.versionNumber;
    });
    expect(published).toBe(2);

    // The navigation's first render latches from the cache as it is right now.
    const latch = nextLatch({ prev: null, locationKey: 'after-publish', requestedNumber: undefined, versions: cachedList() });
    expect(latch?.versionNumber).toBe(published);

    // Once any outstanding refresh lands, the latched version is still the
    // latest, so the page shows no "newer version" notice.
    await waitUntil(() => !qc.isFetching());
    const latest = cachedList()[0]?.versionNumber;
    expect(latch?.versionNumber).toBe(latest);
  });

  it('also refreshes a cached version list that no mounted page is watching (publishing from the library)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // An earlier visit to the document page loaded the list, then the user
    // left: the list stays cached but nothing observes it now.
    const pageHooks: { current: Hooks | null } = { current: null };
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness, { out: pageHooks })));
    });
    await waitUntil(() => (qc.getQueryData<VersionsListResponse>(['versions', DOC])?.versions.length ?? 0) === 1);
    const hooks: { current: { addVersion: ReturnType<typeof useAddVersion> } | null } = { current: null };
    function MutationOnly() {
      hooks.current = { addVersion: useAddVersion(DOC) };
      return null;
    }
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: qc }, createElement(MutationOnly)));
    });
    expect(qc.getQueryCache().find({ queryKey: ['versions', DOC] })?.getObserversCount()).toBe(0);
    const current = hooks.current;
    if (!current) throw new Error('hooks not mounted');
    await act(async () => {
      await current.addVersion.mutateAsync({
        file: new File(['<p>v2</p>'], 'v2.html', { type: 'text/html' }),
        versionNote: null,
      });
    });
    // The document page mounts on this cache entry first: it must already list v2.
    const cached = qc.getQueryData<VersionsListResponse>(['versions', DOC])?.versions ?? [];
    expect(cached[0]?.versionNumber).toBe(2);
  });
});
