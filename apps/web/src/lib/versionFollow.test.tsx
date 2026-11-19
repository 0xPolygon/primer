// @vitest-environment jsdom
//
// A version.published event refreshes the version list and only then
// decides whether to replace the view. The reader can start a comment,
// reply or edit, or navigate away, while that refresh is in flight; the
// decision must use what is true after the refresh, not when the event
// arrived. Every test holds the refresh open, changes the page, then lets
// it resolve.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ThreadDTO } from '@polygonlabs/primer-api-types';
import { createVersionFollower, type FollowState } from './versionFollow.ts';
import { createDraftTracker, DraftReporterContext } from './drafts.ts';
import { ThreadCard } from '../components/ThreadCard.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = 'user-1';

/** The document page as the follower sees it: /d/doc on v4, v5 just
 *  published, the version-list refresh held open until `resolveRefresh`. */
function makePage() {
  const drafts = createDraftTracker();
  const page = {
    composerDirty: false,
    path: '/d/doc',
    locationKey: 'k1',
    docId: 'doc' as string | undefined,
    viewedVersionId: 'v-4',
    viewedVersionNumber: 4,
    latestOnServer: 5,
    latestInCache: 4,
  };
  const navigations: string[] = [];
  const held: (() => void)[] = [];
  const follower = createVersionFollower({
    refreshVersions: () => new Promise<void>((resolve) => held.push(resolve)),
    readState: (): FollowState => ({
      docId: page.docId,
      path: page.path,
      locationKey: page.locationKey,
      requestedNumber: undefined,
      viewedVersionId: page.viewedVersionId,
      viewedVersionNumber: page.viewedVersionNumber,
      latestVersionNumber: page.latestInCache,
      hasUnsentDraft: page.composerDirty || drafts.any(),
    }),
    navigateToLatest: (docId) => navigations.push(`/d/${docId}`),
  });
  return {
    page,
    drafts,
    follower,
    navigations,
    /** Resolves every held refresh and lets the callbacks run. */
    async finishRefresh(): Promise<void> {
      await act(async () => {
        page.latestInCache = page.latestOnServer;
        for (const resolve of held.splice(0)) resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function thread(): ThreadDTO {
  return {
    id: 't-1',
    versionId: 'v-4',
    anchor: { type: 'text-range', selectorText: 'some text', prefix: '', suffix: '', containerPath: 'body' },
    resolvedAt: null,
    resolvedBy: null,
    resolvedByDisplayName: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    comments: [
      {
        id: 'c-1',
        threadId: 't-1',
        authorId: ME,
        authorDisplayName: 'Me',
        body: 'original',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: null,
        deletedAt: null,
        mentions: [],
      },
    ],
  };
}

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/api/users/mentionable')) {
      return new Response(JSON.stringify({ users: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

/** The real sidebar thread card, reporting drafts the way the page wires it. */
async function renderThreadCard(report: (key: string, dirty: boolean) => void): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          DraftReporterContext.Provider,
          { value: report },
          createElement(ThreadCard, {
            versionId: 'v-4',
            thread: thread(),
            drifted: false,
            currentUserId: ME,
            onHighlight: () => {},
          }),
        ),
      ),
    );
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function type(text: string): Promise<void> {
  const ta = container.querySelector('textarea');
  if (!ta) throw new Error('no textarea');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  );

describe('following a newly published version', () => {
  it('replaces the view once the refresh lands, when nothing is being written', async () => {
    const p = makePage();
    p.follower.onVersionPublished();
    expect(p.navigations).toEqual([]); // never before the refresh
    await p.finishRefresh();
    expect(p.navigations).toEqual(['/d/doc']);
  });

  it('stays put when a new comment is typed while the refresh is in flight', async () => {
    const p = makePage();
    p.follower.onVersionPublished();
    p.page.composerDirty = true;
    await p.finishRefresh();
    expect(p.navigations).toEqual([]);
  });

  it('stays put when a reply is typed while the refresh is in flight', async () => {
    const p = makePage();
    await renderThreadCard(p.drafts.report);
    await click(button('Reply'));
    p.follower.onVersionPublished(); // reply box open but empty: no draft yet
    expect(p.drafts.any()).toBe(false);
    await type('a reply');
    expect(p.drafts.any()).toBe(true);
    await p.finishRefresh();
    expect(p.navigations).toEqual([]);
  });

  it('stays put when an edit is typed while the refresh is in flight', async () => {
    const p = makePage();
    await renderThreadCard(p.drafts.report);
    await click(button('Edit comment'));
    p.follower.onVersionPublished(); // editing, text unchanged: no draft yet
    expect(p.drafts.any()).toBe(false);
    await type('original, edited');
    expect(p.drafts.any()).toBe(true);
    await p.finishRefresh();
    expect(p.navigations).toEqual([]);
  });

  it('stays put when the reader navigates away while the refresh is in flight', async () => {
    const p = makePage();
    p.follower.onVersionPublished();
    p.page.path = '/library'; // the router has moved on; the page has not re-rendered yet
    await p.finishRefresh();
    expect(p.navigations).toEqual([]);

    const q = makePage();
    q.follower.onVersionPublished();
    q.page.locationKey = 'k2'; // e.g. the version switcher, same path
    await q.finishRefresh();
    expect(q.navigations).toEqual([]);

    const r = makePage();
    r.follower.onVersionPublished();
    r.follower.dispose(); // page unmounted or switched document: its refs are frozen
    await r.finishRefresh();
    expect(r.navigations).toEqual([]);
  });

  it('acts once for a burst, and not at all for an event about a version already shown', async () => {
    const p = makePage();
    p.follower.onVersionPublished();
    p.follower.onVersionPublished(); // supersedes the first
    await p.finishRefresh();
    expect(p.navigations).toEqual(['/d/doc']);

    const old = makePage();
    old.page.latestOnServer = 4; // e.g. a replayed v4 event
    old.follower.onVersionPublished();
    await old.finishRefresh();
    expect(old.navigations).toEqual([]);
  });
});
