import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { proposeBranch } from './branch.ts';
import { copyDocument } from './copy.ts';
import { commentedThreadIds, fragmentDoc } from './marks.ts';
import { comment, createLiveDoc, makeAgent, markdownOf, ops, paragraph, seedBlocks, versions, withLiveDoc } from './live.testlib.ts';
import { decideChangeSet, decideSuggestion, listSuggestions } from './suggest.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });

async function withStorage<T>(fn: (storage: Storage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-copy-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A parent with three paragraphs, a commented one and an image, and a
 *  branch of it made by the owner. */
async function branched(storage: Storage) {
  const parent = await createLiveDoc();
  const fileId = uuidv7();
  await storage.put(`files/${parent}/${fileId}`, new TextEncoder().encode('png'));
  await db.execute(sql`
    INSERT INTO doc_files (id, document_id, storage_key, content_type, size_bytes, uploaded_by)
    VALUES (${fileId}, ${parent}, ${`files/${parent}/${fileId}`}, 'image/png', 3, 'mock-user-1')
  `);
  await seedBlocks(parent, [
    paragraph('a', 'Alpha'),
    paragraph('b', 'Beta'),
    paragraph('c', 'Gamma'),
    { id: 'img', type: 'image', props: { url: `primer-blob://${fileId}` } } as never,
  ]);
  const threadId = await comment(parent, 'b', 'Beta');
  const out = await copyDocument(storage, owner, parent, 'branch');
  if (!out.ok) throw new Error(out.refusal.message);
  return { parent, branch: out.documentId, threadId, fileId };
}

async function propose(storage: Storage, branch: string) {
  const out = await proposeBranch(storage, owner, branch);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

async function openSuggestions(documentId: string) {
  const out = await listSuggestions(owner, documentId);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

describe('branches', () => {
  it('branch proposal arrives as one change set and accepting applies all', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const v = await versions(branch, agent);
      await ops(branch, agent, {
        ops: [
          { op: 'update', target: main('a'), block: 'Alpha, on the branch', expectVersion: v.a },
          { op: 'add', at: main('c'), position: 'after', blocks: ['Delta', 'Epsilon'] },
        ],
      });

      const proposal = await propose(storage, branch);
      expect(proposal.changeSetId).toBe(branch);
      expect(proposal.outcomes.every((o) => o.status === 'suggested')).toBe(true);
      const open = await openSuggestions(parent);
      expect(open).toHaveLength(2);
      expect(open.every((s) => s.changeSetId === branch && !s.conflict)).toBe(true);
      // The parent is untouched until someone decides.
      expect(await markdownOf(parent, agent)).toEqual(['Alpha', 'Beta', 'Gamma', expect.any(String)]);

      const accepted = await decideChangeSet(branch, owner, 'accept');
      expect(accepted.ok && accepted.value.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);
      expect((await markdownOf(parent, agent)).filter((m) => !m.startsWith('!'))).toEqual(['Alpha, on the branch', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
      expect(await openSuggestions(parent)).toEqual([]);
    });
  });

  it('a parent-only edit is never proposed for reversal', async () => {
    await withStorage(async (storage) => {
      const { parent, branch, threadId } = await branched(storage);
      const agent = await makeAgent();
      // An untouched branch (with its comment and image) proposes nothing.
      expect((await propose(storage, branch)).outcomes).toEqual([]);

      const pv = await versions(parent, agent);
      await ops(parent, agent, { ops: [{ op: 'update', target: main('c'), block: 'Gamma, edited on the parent', expectVersion: pv.c }] });
      await ops(parent, agent, { ops: [{ op: 'delete', target: main('a'), expectVersion: pv.a }] });
      const bv = await versions(branch, agent);
      await ops(branch, agent, { ops: [{ op: 'update', target: main('b'), block: 'Beta, on the branch', expectVersion: bv.b }] });

      const proposal = await propose(storage, branch);
      expect(proposal.outcomes).toHaveLength(1);
      const [only] = await openSuggestions(parent);
      expect(only!.edits.map((e) => e.target.blockId)).toEqual(['b']);
      expect(await decideSuggestion(only!.id, owner, 'accept')).toMatchObject({ ok: true });
      expect((await markdownOf(parent, agent)).slice(0, 2)).toEqual(['Beta, on the branch', 'Gamma, edited on the parent']);
      // The parent's own thread is still on its text; the branch's copy isn't.
      expect(await withLiveDoc(parent, (doc) => commentedThreadIds(fragmentDoc(doc.getXmlFragment('document-store'))))).toEqual([threadId]);
    });
  });

  it('a branch does not copy soft-deleted comments', async () => {
    await withStorage(async (storage) => {
      const parent = await createLiveDoc();
      await seedBlocks(parent, [paragraph('a', 'Alpha')]);
      const threadId = await comment(parent, 'a', 'Alpha');
      const keptId = uuidv7();
      await db.execute(sql`
        INSERT INTO comments (id, thread_id, author_id, body, mentions)
        VALUES (${keptId}, ${threadId}, 'mock-user-1', 'keep me', '{}'),
               (${uuidv7()}, ${threadId}, 'mock-user-1', 'deleted one', '{}')
      `);
      await db.execute(sql`UPDATE comments SET deleted_at = now() WHERE thread_id = ${threadId} AND body = 'deleted one'`);

      const out = await copyDocument(storage, owner, parent, 'branch');
      if (!out.ok) throw new Error(out.refusal.message);
      const copied = (await db.execute(sql`
        SELECT c.body FROM comments c JOIN threads t ON t.id = c.thread_id WHERE t.document_id = ${out.documentId}
      `)) as unknown as { body: string }[];
      expect(copied.map((c) => c.body)).toEqual(['keep me']);
    });
  });

  it('a block changed on both sides is a conflict', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const pv = await versions(parent, agent);
      await ops(parent, agent, { ops: [{ op: 'update', target: main('a'), block: 'Alpha, the parent\'s', expectVersion: pv.a }] });
      const bv = await versions(branch, agent);
      await ops(branch, agent, {
        ops: [
          { op: 'update', target: main('a'), block: 'Alpha, the branch\'s', expectVersion: bv.a },
          { op: 'update', target: main('c'), block: 'Gamma, the branch\'s', expectVersion: bv.c },
        ],
      });

      await propose(storage, branch);
      const open = await openSuggestions(parent);
      const conflict = open.find((s) => s.conflict)!;
      expect(conflict.edits[0]).toMatchObject({ target: main('a'), current: { markdown: 'Alpha, the parent\'s' }, proposed: { markdown: 'Alpha, the branch\'s' } });
      expect(open.filter((s) => !s.conflict).map((s) => s.edits[0]!.target.blockId)).toEqual(['c']);

      // Accepting the set leaves the conflict to be decided on its own.
      await decideChangeSet(branch, owner, 'accept');
      expect((await markdownOf(parent, agent)).slice(0, 3)).toEqual(['Alpha, the parent\'s', 'Beta', 'Gamma, the branch\'s']);
      expect((await openSuggestions(parent)).map((s) => s.id)).toEqual([conflict.id]);

      // Proposing again replaces the open set instead of adding to it.
      await propose(storage, branch);
      const again = await openSuggestions(parent);
      expect(again).toHaveLength(1);
      expect(again[0]!.conflict).toBe(true);
    });
  });
  it('a moved block is proposed as one move that keeps the branch order', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const bv = await versions(branch, agent);
      await ops(branch, agent, { ops: [{ op: 'move', target: main('c'), at: main('a'), position: 'before', expectVersion: bv.c }] });

      await propose(storage, branch);
      const open = await openSuggestions(parent);
      expect(open.flatMap((s) => s.edits.map((e) => [e.kind, e.target.blockId]))).toEqual([['move', 'c']]);
      await decideSuggestion(open[0]!.id, owner, 'accept');
      expect((await markdownOf(parent, agent)).slice(0, 3)).toEqual(['Gamma', 'Alpha', 'Beta']);
    });
  });

  it('blocks moved together keep their order relative to each other', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const bv = await versions(branch, agent);
      await ops(branch, agent, { ops: [{ op: 'move', target: main('c'), at: main('a'), position: 'before', expectVersion: bv.c }] });
      await ops(branch, agent, { ops: [{ op: 'move', target: main('img'), at: main('a'), position: 'before', expectVersion: bv.img }] });

      await propose(storage, branch);
      await decideChangeSet(branch, owner, 'accept');
      expect((await markdownOf(parent, agent)).map((m) => (m.startsWith('!') ? 'img' : m))).toEqual(['Gamma', 'img', 'Alpha', 'Beta']);
    });
  });

  it('a comment the parent added to unchanged text survives a proposed edit of the block', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const parentThread = await comment(parent, 'a', 'Alpha');
      const bv = await versions(branch, agent);
      await ops(branch, agent, { ops: [{ op: 'update', target: main('a'), block: 'Alpha, edited on the branch', expectVersion: bv.a }] });

      await propose(storage, branch);
      await decideChangeSet(branch, owner, 'accept');
      expect((await markdownOf(parent, agent))[0]).toBe('Alpha, edited on the branch');
      expect(await withLiveDoc(parent, (doc) => commentedThreadIds(fragmentDoc(doc.getXmlFragment('document-store'))))).toContain(parentThread);
    });
  });
});

describe('forks', () => {
  it('fork keeps content and block ids but strips marks and threads', async () => {
    await withStorage(async (storage) => {
      const { parent, fileId } = await branched(storage);
      await db.execute(sql`
        INSERT INTO doc_records (document_id, collection, record_id, scope, owner_user_id, data, contributors, version, updated_by)
        VALUES (${parent}, 'votes', 'shared-1', 'shared', NULL, '{"n":1}', '{mock-user-1}', 1, 'mock-user-1'),
               (${parent}, 'votes', 'mine-1', 'personal', 'mock-user-1', '{"n":2}', '{mock-user-1}', 1, 'mock-user-1')
      `);
      const out = await copyDocument(storage, owner, parent, 'fork', 'Remix');
      if (!out.ok) throw new Error(out.refusal.message);
      const fork = out.documentId;
      const agent = await makeAgent();

      expect(Object.keys(await versions(fork, agent))).toEqual(Object.keys(await versions(parent, agent)));
      expect((await markdownOf(fork, agent)).slice(0, 3)).toEqual(['Alpha', 'Beta', 'Gamma']);
      const content = await withLiveDoc(fork, (doc) => fragmentDoc(doc.getXmlFragment('document-store')));
      expect(commentedThreadIds(content)).toEqual([]);
      const threads = (await db.execute(sql`SELECT id FROM threads WHERE document_id = ${fork}`)) as unknown as unknown[];
      expect(threads).toEqual([]);

      // Its file is its own copy.
      const [file] = (await db.execute(sql`SELECT id, copied_from AS "from" FROM doc_files WHERE document_id = ${fork}`)) as unknown as { id: string; from: string }[];
      expect(file!.from).toBe(fileId);
      expect(JSON.stringify(content.toJSON())).toContain(`primer-blob://${file!.id}`);
      // Shared records come along; personal ones don't.
      const records = (await db.execute(sql`SELECT record_id AS id FROM doc_records WHERE document_id = ${fork}`)) as unknown as { id: string }[];
      expect(records.map((r) => r.id)).toEqual(['shared-1']);
      // A checkpoint to share and compare from.
      const [v] = (await db.execute(sql`SELECT version_number AS n FROM versions WHERE document_id = ${fork}`)) as unknown as { n: number }[];
      expect(v!.n).toBe(1);
    });
  });
});
