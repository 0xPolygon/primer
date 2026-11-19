import { describe, expect, it, vi } from 'vitest';
import type { OutboundProtocolMessage } from '../companion/protocol.ts';
import { parseInboundMessage } from '../companion/protocol.ts';
import type { EventSourceLike } from '../lib/eventsFeed.ts';
import { createRecordsHost, loadPageBinding } from './recordsHost.ts';

const DOC = '01900000-0000-7000-8000-000000000001';
const VER = '01900000-0000-7000-8000-000000000002';
const RECORDS = { documentId: DOC, versionId: VER, policy: 'records' as const };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(binding: Parameters<typeof createRecordsHost>[0]) {
  const fetched: string[] = [];
  const streams: (EventSourceLike & { url: string; closed: boolean })[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    fetched.push(url);
    if (url.includes('/records/changes')) return json({ changes: [{ id: 7 }], toChangeId: 7, hasMore: false });
    return json({ records: [], nextCursor: null });
  });
  const host = createRecordsHost(binding, {
    fetchImpl,
    eventSourceFactory: (url) => {
      const s = { url, closed: false, onmessage: null, onopen: null, onerror: null, close() { s.closed = true; } } as EventSourceLike & { url: string; closed: boolean };
      streams.push(s);
      return s;
    },
  });
  const posted: OutboundProtocolMessage[] = [];
  host.attach((m) => posted.push(m));
  const call = (callId: string, verb: string, args: Record<string, unknown>) => {
    const msg = parseInboundMessage({ type: 'records_call', callId, verb, args });
    if (!msg) throw new Error('rejected by the parser');
    return host.handle(msg);
  };
  return { host, posted, fetched, streams, call };
}

describe('records host', () => {
  it('binds a page from the server, never from the page', async () => {
    const fetchImpl = vi.fn(async () => json(RECORDS));
    expect(await loadPageBinding(`/api/versions/${VER}/content`, fetchImpl)).toEqual(RECORDS);
    expect(fetchImpl).toHaveBeenCalledWith(`/api/versions/${VER}/page`);
    expect(await loadPageBinding('/api/share/abc/content', fetchImpl)).toBe('none');
    expect(await loadPageBinding(`/api/versions/${VER}/content`, async () => json({}, 500))).toBe('unknown');
  });

  it('record-reading pages get the records feature and no way out', () => {
    expect(harness(RECORDS).host).toMatchObject({ features: ['records'], allowsOutbound: false });
    expect(harness({ ...RECORDS, policy: 'standard' }).host).toMatchObject({ features: [], allowsOutbound: true });
    // Fail closed when the page's policy could not be learned.
    expect(harness('unknown').host).toMatchObject({ features: [], allowsOutbound: false });
  });

  it('bridge refuses record verbs for pages without the opt-in', async () => {
    for (const binding of [{ ...RECORDS, policy: 'standard' as const }, 'none' as const, 'unknown' as const]) {
      const h = harness(binding);
      expect(h.call('c1', 'list', { collection: 'votes', scope: 'shared' })).toBe(true);
      expect(h.fetched).toEqual([]);
      expect(h.posted).toEqual([expect.objectContaining({ type: 'records_result', callId: 'c1', ok: false, refusal: expect.objectContaining({ code: 'records_unavailable' }) })]);
      expect(h.streams).toEqual([]);
    }
  });

  it('frame navigation revokes record access', async () => {
    const h = harness(RECORDS);
    expect(h.host.onLoad()).toBe('ok');
    h.call('c1', 'list', { collection: 'votes', scope: 'shared' });
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.posted[0]).toMatchObject({ ok: true });

    // The page navigated itself: its second load is a breach.
    expect(h.host.onLoad()).toBe('breach');
    expect(h.host.capability?.revoked).toBe(true);
    expect(h.streams[0].closed).toBe(true);
    h.call('c2', 'list', { collection: 'votes', scope: 'shared' });
    expect(h.posted[1]).toMatchObject({ callId: 'c2', ok: false, refusal: { code: 'records_unavailable' } });
    expect(h.fetched).toHaveLength(1);
  });

  it('records_changed after reconnect is caught up via changesSince', async () => {
    const h = harness(RECORDS);
    expect(h.streams[0].url).toBe(`/api/documents/${DOC}/events/stream?namespace=primer&type=data.changed`);
    h.streams[0].onmessage?.({ data: JSON.stringify({ id: 3, payload: { document_id: DOC, collections: ['votes'], from_change_id: 4, to_change_id: 5 } }) });
    expect(h.posted).toEqual([{ type: 'records_changed', collections: ['votes'], toChangeId: 5 }]);
    // After a gap the page asks for everything since the last change it saw.
    h.call('c1', 'changesSince', { changeId: 5, documentId: 'other' });
    await vi.waitFor(() => expect(h.posted).toHaveLength(2));
    expect(h.fetched).toEqual([`/api/documents/${DOC}/records/changes?since=5`]);
    expect(h.posted[1]).toMatchObject({ callId: 'c1', ok: true, value: { toChangeId: 7 } });
  });
});
