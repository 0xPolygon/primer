import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageInfoResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { readsRecords } from './page.ts';
import { recordsApi } from './store.ts';
import { flushDataChanged } from './changed.ts';
import { MOCK_USER } from '../auth/resolver.ts';

const POLL = `<!doctype html><html><head><meta charset="utf-8"><meta name="primer-records" content="read"><title>Poll</title></head>
<body><button id="a">A</button><img src="https://evil.example/x.png"></body></html>`;

async function publish(app: ReturnType<typeof createApp>, html: string): Promise<{ documentId: string; versionId: string }> {
  const fd = new FormData();
  fd.append('file', new Blob([html], { type: 'text/html' }), 'p.html');
  fd.append('title', 'Poll');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  return (await res.json()) as { documentId: string; versionId: string };
}

describe('record-reading pages', () => {
  it('record-reading page gets the records policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-page-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      // The opt-in survives the publish pipeline (sanitizer included).
      const poll = await publish(app, POLL);
      const res = await app.request(`/api/versions/${poll.versionId}/content`);
      expect(res.headers.get('content-security-policy')).toBe(artifactCsp('records'));
      expect(readsRecords(await res.text())).toBe(true);
      const info = (await (await app.request(`/api/versions/${poll.versionId}/page`)).json()) as PageInfoResponse;
      // An upload is a checkpoint of a live page: it reads the records frozen with it.
      expect(info).toEqual({ documentId: poll.documentId, versionId: poll.versionId, policy: 'records', frozen: true });

      const plain = await publish(app, '<html><body><p>primer-records</p></body></html>');
      const plainRes = await app.request(`/api/versions/${plain.versionId}/content`);
      expect(plainRes.headers.get('content-security-policy')).toBe(artifactCsp('standard'));
      const plainInfo = (await (await app.request(`/api/versions/${plain.versionId}/page`)).json()) as PageInfoResponse;
      expect(plainInfo.policy).toBe('standard');
      expect((await app.request('/api/versions/00000000-0000-0000-0000-000000000000/page')).status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only a head meta with content="read" opts in', () => {
    expect(readsRecords('<head><meta content="read" name="primer-records"></head>')).toBe(true);
    expect(readsRecords('<head><meta name="primer-records" content="write"></head>')).toBe(false);
    expect(readsRecords('<head></head><body><meta name="primer-records" content="read"></body>')).toBe(false);
  });

  it('records are never tied to page versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-page-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const poll = await publish(app, POLL);
      const api = recordsApi(MOCK_USER, poll.documentId);
      await api.set({ collection: 'votes', scope: 'shared', recordId: 'a', data: { option: 'tacos' } });
      // A new version of the page leaves the records as they were.
      const fd = new FormData();
      fd.append('file', new Blob([POLL.replace('Poll', 'Poll v2')], { type: 'text/html' }), 'p.html');
      const v2 = await app.request(`/api/documents/${poll.documentId}/versions`, { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(v2.status).toBeLessThan(300);
      const after = await api.list({ collection: 'votes', scope: 'shared' });
      expect(after.ok && after.value.records.map((r) => [r.recordId, r.data, r.version])).toEqual([['a', { option: 'tacos' }, 1]]);
      await flushDataChanged();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
