import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, documentCollaborators, users } from '../db/schema.ts';
import type { Notifier, NotifyCommentArgs, NotifyCollaboratorAddedArgs } from '../notifications/notifier.ts';
import type { Collaborator, CollaboratorsListResponse } from '@polygonlabs/primer-api-types';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class SpyNotifier implements Notifier {
  readonly emailEnabled = false;
  collabCalls: NotifyCollaboratorAddedArgs[] = [];
  commentCalls: NotifyCommentArgs[] = [];
  async notifyComment(args: NotifyCommentArgs): Promise<void> { this.commentCalls.push(args); }
  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> { this.collabCalls.push(args); }
  async notifyExternalOtp() {}
  async notifyExternalFirstView() {}
  async notifyDocumentMention() {}
}

async function withMultiUserApp<T>(
  fn: (app: ReturnType<typeof createApp>, notifier: SpyNotifier) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-collabroutes-'));
  try {
    const notifier = new SpyNotifier();
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier,
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
      ])
      .onConflictDoNothing();
    return await fn(app, notifier);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/documents/:docId/collaborators', () => {
  it('owner: returns empty list initially', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollaboratorsListResponse;
      expect(body.collaborators).toEqual([]);
    });
  });

  it('non-owner (canRead but not canManage): 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(403);
    });
  });

  it('stranger on private doc: 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(404);
    });
  });

  it('returns rows with displayName joined', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        { headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollaboratorsListResponse;
      expect(body.collaborators).toHaveLength(1);
      expect(body.collaborators[0]).toMatchObject({
        userId: 'mock-user-2',
        displayName: 'User Two',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
    });
  });
});

describe('POST /api/documents/:docId/collaborators', () => {
  it('owner adds editor: 201 + calls notifier with exact args', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'editor' }),
        },
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as Collaborator;
      expect(body).toMatchObject({
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
        displayName: 'User Two',
      });
      // Notifier fired exactly once with the right shape.
      expect(notifier.collabCalls).toHaveLength(1);
      expect(notifier.collabCalls[0]).toEqual({
        docId: upload.documentId,
        docTitle: 'Fixture doc',
        addedUserId: 'mock-user-2',
        addedByUserId: 'mock-user-1',
        role: 'editor',
      });
    });
  });

  it('non-owner: 403 and notifier not called', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-2'),
          body: JSON.stringify({ userId: 'mock-user-3', role: 'editor' }),
        },
      );
      expect(res.status).toBe(403);
      expect(notifier.collabCalls).toHaveLength(0);
    });
  });

  it('owner_not_collaborator (400) when adding owner as their own collab', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-1', role: 'editor' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('owner_not_collaborator');
      expect(notifier.collabCalls).toHaveLength(0);
    });
  });

  it('invalid_role_for_visibility (400) when adding commenter under org visibility', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'commenter' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_role_for_visibility');
      expect(notifier.collabCalls).toHaveLength(0);
    });
  });

  it('commenter allowed under private visibility', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'commenter' }),
        },
      );
      expect(res.status).toBe(201);
    });
  });

  it('owner adds responder under org: 201, notifier called with role responder', async () => {
    await withMultiUserApp(async (app, notifier) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'responder' }),
        },
      );
      expect(res.status).toBe(201);
      expect(((await res.json()) as Collaborator).role).toBe('responder');
      expect(notifier.collabCalls).toHaveLength(1);
      expect(notifier.collabCalls[0]?.role).toBe('responder');
    });
  });

  it('owner adds responder under private: 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'responder' }),
        },
      );
      expect(res.status).toBe(201);
    });
  });

  it('invalid role value manager: 400 invalid_body naming commenter|responder|editor', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'manager' }),
        },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_body');
      expect(body.message).toContain('commenter|responder|editor');
    });
  });

  it('PATCH with invalid role value manager: 400 invalid_body naming commenter|responder|editor, row unchanged', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const add = await app.request(`/api/documents/${upload.documentId}/collaborators`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ userId: 'mock-user-2', role: 'responder' }),
      });
      expect(add.status).toBe(201);
      const res = await app.request(`/api/documents/${upload.documentId}/collaborators/mock-user-2`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ role: 'manager' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_body');
      expect(body.message).toContain('commenter|responder|editor');
      // The stored role is untouched.
      const list = await app.request(`/api/documents/${upload.documentId}/collaborators`, {
        headers: asUser('mock-user-1'),
      });
      const rows = ((await list.json()) as { collaborators: { userId: string; role: string }[] }).collaborators;
      expect(rows.find((r) => r.userId === 'mock-user-2')).toHaveProperty('role', 'responder');
    });
  });

  it('collaborator_exists (409) on duplicate add', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      // First add succeeds.
      const r1 = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'editor' }),
        },
      );
      expect(r1.status).toBe(201);
      // Second add of same (doc, user) fails on the unique constraint.
      const r2 = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2', role: 'editor' }),
        },
      );
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as { error: string }).error).toBe('collaborator_exists');
    });
  });

  it('invalid_body (400) on missing fields', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators`,
        {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ userId: 'mock-user-2' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });
});

describe('PATCH /api/documents/:docId/collaborators/:userId', () => {
  it('owner changes role: 200', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'commenter', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'editor' }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Collaborator;
      expect(body.role).toBe('editor');
    });
  });

  it('non-owner: 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-2'),
          body: JSON.stringify({ role: 'commenter' }),
        },
      );
      expect(res.status).toBe(403);
    });
  });

  it('invalid_role_for_visibility (400) when changing to commenter under org', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'commenter' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_role_for_visibility');
    });
  });

  it('PATCH commenter to responder under org: 200 (the ghost-row upgrade path)', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      // A commenter row left over from a private→org visibility flip.
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'commenter', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'responder' }),
        },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as Collaborator).role).toBe('responder');
    });
  });

  it('PATCH responder to commenter under org: 400 invalid_role_for_visibility', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'responder', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'commenter' }),
        },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_role_for_visibility');
    });
  });

  it('not_found (404) when target userId has no collab row', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        {
          method: 'PATCH',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ role: 'editor' }),
        },
      );
      expect(res.status).toBe(404);
    });
  });
});

describe('DELETE /api/documents/:docId/collaborators/:userId', () => {
  it('owner removes: 204', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        { method: 'DELETE', headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(204);
      const rows = await db.select().from(documentCollaborators).where(
        drizzleSql`document_id = ${upload.documentId} AND user_id = 'mock-user-2'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('non-owner: 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId: upload.documentId, userId: 'mock-user-2',
        role: 'editor', grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        { method: 'DELETE', headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(403);
    });
  });

  it('idempotent: DELETE on already-absent row returns 204', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(
        `/api/documents/${upload.documentId}/collaborators/mock-user-2`,
        { method: 'DELETE', headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(204);
    });
  });
});
