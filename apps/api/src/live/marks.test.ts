import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { isValidAnchor, type ThreadDTO } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { createApp } from '../app.ts';
import { db } from '../db/client.ts';
import { documentCollaborators, users } from '../db/schema.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { asUser, asUserJson } from '../test/harness.ts';
import { findQuote, fragmentDoc, presentThreadIds, toRelative } from './marks.ts';
import { loadYDoc } from './persist.ts';
import { createLiveDoc, paragraph, seedBlocks, startTestHub, until } from './live.testlib.ts';

const OWNER = 'mock-user-1';
const target = (blockId: string) => ({ tabId: 'main', blockId });

let hub: Awaited<ReturnType<typeof startTestHub>>;
beforeAll(async () => {
  hub = await startTestHub();
});
afterAll(async () => {
  await hub.close();
});

async function makeApp() {
  const storage = new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-marks-')));
  return { app: createApp({ storage, notifier: new NoopNotifier(), userResolver: mockMultiResolver }), storage };
}

async function addUser(id: string, opts: { role?: 'commenter' | 'editor'; documentId?: string; agentOf?: string } = {}) {
  await db
    .insert(users)
    .values({ id, email: `${id}@example.com`, displayName: id, kind: opts.agentOf ? 'agent' : 'person', viaUserId: opts.agentOf ?? null })
    .onConflictDoNothing();
  if (opts.role && opts.documentId) {
    await db.insert(documentCollaborators).values({ id: uuidv7(), documentId: opts.documentId, userId: id, role: opts.role, grantedBy: OWNER });
  }
}

async function liveDocWith(text: string): Promise<string> {
  const id = await createLiveDoc({ uploaderId: OWNER });
  await seedBlocks(id, [paragraph('p1', text), paragraph('p2', 'Second paragraph')]);
  return id;
}

describe('threads on live documents', () => {
  it('commenter creates an anchored thread over a read-only socket', async () => {
    const { app } = await makeApp();
    const id = await liveDocWith('Hello brave new world');
    await addUser('commenter-1', { role: 'commenter', documentId: id });
    const client = await hub.connect(id, 'commenter-1');

    // The commenter's editor sends its selection as Yjs relative positions.
    const fragment = client.doc.getXmlFragment('document-store');
    const range = findQuote(fragmentDoc(fragment), 'p1', 'brave')!;
    const res = await app.request(`/api/documents/${id}/threads`, {
      method: 'POST',
      headers: asUserJson('commenter-1'),
      body: JSON.stringify({
        anchor: { type: 'prose', target: target('p1'), quote: 'brave' },
        body: 'Why brave?',
        selection: { anchor: toRelative(fragment, range.from), head: toRelative(fragment, range.to) },
      }),
    });
    expect(res.status).toBe(201);
    const thread = (await res.json()) as ThreadDTO;
    expect(thread.anchor).toEqual({ type: 'prose', target: target('p1'), quote: 'brave' });
    expect(thread.versionId).toBeNull();

    // The server wrote the mark: the stored doc has it, and it synced back.
    const { doc } = await loadYDoc(id);
    expect(presentThreadIds(doc).has(thread.id)).toBe(true);
    await until(() => presentThreadIds(client.doc).has(thread.id));

    const list = await app.request(`/api/documents/${id}/threads`, { headers: asUser('commenter-1') });
    expect(((await list.json()) as { threads: ThreadDTO[] }).threads.map((t) => t.id)).toEqual([thread.id]);
  });

  it('agent creates a thread by quote via MCP', async () => {
    const { storage } = await makeApp();
    const id = await liveDocWith('Ship it on Friday');
    await addUser('agent-1', { agentOf: OWNER });
    const agent: AuthUser = { id: 'agent-1', email: 'agent-1@example.com', displayName: 'agent-1', kind: 'agent', viaUserId: OWNER };
    const tools = buildMcpToolHandlers({ storage, notifier: new NoopNotifier(), apiBaseUrl: 'https://primer.test' });

    const out = await tools.primer_create_thread({ documentId: id, target: target('p1'), quote: 'Friday', body: 'Which Friday?' }, agent);
    expect(out.isError).toBeFalsy();
    const { thread_id } = JSON.parse(out.content[0]!.text) as { thread_id: string };
    expect(presentThreadIds((await loadYDoc(id)).doc).has(thread_id)).toBe(true);

    const missing = await tools.primer_create_thread({ documentId: id, target: target('p1'), quote: 'Monday', body: 'x' }, agent);
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('quote_not_found');
  });

  it('reactions toggle per user', async () => {
    const { app } = await makeApp();
    const id = await liveDocWith('React to this');
    await addUser('editor-1', { role: 'editor', documentId: id });
    const created = await app.request(`/api/documents/${id}/threads`, {
      method: 'POST',
      headers: asUserJson(OWNER),
      body: JSON.stringify({ anchor: { type: 'prose', target: target('p1'), quote: 'React' }, body: 'Thoughts?' }),
    });
    const thread = (await created.json()) as ThreadDTO;
    const commentId = thread.comments[0]!.id;
    const react = (user: string, method: 'POST' | 'DELETE') =>
      app.request(`/api/comments/${commentId}/reactions/${encodeURIComponent('👍')}`, { method, headers: asUser(user) });

    await react(OWNER, 'POST');
    await react('editor-1', 'POST');
    await react('editor-1', 'POST');
    let after = (await (await react(OWNER, 'POST')).json()) as ThreadDTO;
    expect(after.comments[0]!.reactions).toEqual([{ emoji: '👍', userIds: [OWNER, 'editor-1'] }]);
    after = (await (await react(OWNER, 'DELETE')).json()) as ThreadDTO;
    expect(after.comments[0]!.reactions).toEqual([{ emoji: '👍', userIds: ['editor-1'] }]);
  });

  it('resolve works on a live thread', async () => {
    const { app } = await makeApp();
    const id = await liveDocWith('Resolve me');
    const created = await app.request(`/api/documents/${id}/threads`, {
      method: 'POST',
      headers: asUserJson(OWNER),
      body: JSON.stringify({ anchor: { type: 'prose', target: target('p1'), quote: 'Resolve' }, body: 'Done?' }),
    });
    const thread = (await created.json()) as ThreadDTO;
    const res = await app.request(`/api/threads/${thread.id}/resolve`, { method: 'POST', headers: asUser(OWNER) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ThreadDTO).resolvedAt).not.toBeNull();
  });

  it('anchor validator accepts every C6 kind and rejects unknown', () => {
    const t = target('b1');
    expect(isValidAnchor({ type: 'prose', target: t, quote: 'x' })).toBe(true);
    expect(isValidAnchor({ type: 'prose', target: { ...t, pid: 'p3' }, quote: 'x' })).toBe(true);
    expect(isValidAnchor({ type: 'widget-part', target: t, anchor: 'axis' })).toBe(true);
    expect(isValidAnchor({ type: 'data-point', target: t, row: 'r1', column: 'c1' })).toBe(true);
    expect(isValidAnchor({ type: 'block', target: t })).toBe(true);
    expect(isValidAnchor({ type: 'text-range', selectorText: 'x', start: 0, end: 1 })).toBe(true);
    expect(isValidAnchor({ type: 'prose', target: { ...t, pid: 'p', textId: 't' }, quote: 'x' })).toBe(false);
    expect(isValidAnchor({ type: 'prose', target: t, quote: '' })).toBe(false);
    expect(isValidAnchor({ type: 'shape', target: t })).toBe(false);
  });
});
