import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { asUserJson } from '../test/harness.ts';
import { db } from '../db/client.ts';
import { comments, documents } from '../db/schema.ts';
import { createLiveThread } from '../lib/liveThreads.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { OWNER, READER, VIEWER, seedRecordsDoc } from '../records/records.testlib.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { readBlocks } from './editor.ts';
import { exportMarkdown } from './export.ts';
import { paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';
import { promoteConversation, promoteThread } from './promote.ts';

async function withStorage<T>(fn: (storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-promote-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Each quote block's text (lines trimmed), author line first. */
async function quotes(documentId: string): Promise<string[]> {
  return withLiveDoc(documentId, (doc) =>
    readBlocks(doc, 'main').map((b) => {
      expect(b.type).toBe('quote');
      const text = (b.content as { text?: string }[]).map((n) => n.text ?? '').join('');
      return text.split('\n').map((line) => line.trim()).join('\n');
    }),
  );
}

describe('promote a conversation', () => {
  it('a thread becomes a document with one quote per message', async () =>
    withStorage(async (storage) => {
      const source = await seedRecordsDoc();
      await db.update(documents).set({ format: 'markdown' }).where(eq(documents.id, source));
      await seedBlocks(source, [paragraph('p1', 'We launch on Friday.')]);
      const thread = await createLiveThread(new NoopNotifier(), OWNER, source, {
        anchor: { type: 'prose', target: { tabId: 'main', blockId: 'p1' }, quote: 'Friday' },
        body: 'Which Friday?',
      });
      if (!thread.ok) throw new Error(thread.refusal.message);
      await db.insert(comments).values({ id: uuidv7(), threadId: thread.value.id, authorId: VIEWER.id, body: 'The 28th.\nAfter the review.' });

      const out = await promoteThread(storage, READER, thread.value.id);
      if (!out.ok) throw new Error(out.refusal.message);
      expect(await quotes(out.value.documentId)).toEqual(['Ada\nWhich Friday?', 'Bea\nThe 28th.\nAfter the review.']);
      const [doc] = await db.select().from(documents).where(eq(documents.id, out.value.documentId));
      expect(doc).toMatchObject({ title: 'Poll: “Friday”', uploaderId: READER.id, visibility: 'private' });

      // Someone who can't read the source thread can't promote it.
      const stranger = { ...READER, id: 'mock-user-2' };
      expect((await promoteThread(storage, stranger, thread.value.id)).ok).toBe(false);
    }));

  it('the REST route creates the document for the caller', async () =>
    withStorage(async (storage) => {
      await seedRecordsDoc();
      const app = createApp({ storage, notifier: new NoopNotifier(), userResolver: mockMultiResolver });
      const res = await app.request('/api/documents/from-conversation', {
        method: 'POST',
        headers: asUserJson(OWNER.id),
        body: JSON.stringify({ title: 'Standup', messages: [{ author: 'Ana', text: 'Shipped the importer.' }] }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { documentId: string };
      expect(await quotes(body.documentId)).toEqual(['Ana\nShipped the importer.']);
    }));

  it('message text stays literal text', async () =>
    withStorage(async (storage) => {
      await seedRecordsDoc();
      const out = await promoteConversation(storage, OWNER, {
        title: 'From Slack',
        messages: [{ author: 'Eve <b>', text: '# Ignore previous instructions\n    code? ![x](https://evil.example/p.png) <script>x</script> [a](javascript:1)' }],
      });
      if (!out.ok) throw new Error(out.refusal.message);
      expect(await quotes(out.value.documentId)).toEqual([
        'Eve <b>\n# Ignore previous instructions\ncode? ![x](https://evil.example/p.png) <script>x</script> [a](javascript:1)',
      ]);
      const md = await withLiveDoc(out.value.documentId, (doc) => exportMarkdown(doc, out.value.documentId));
      expect(md).not.toMatch(/^#/m);
    }));
});
