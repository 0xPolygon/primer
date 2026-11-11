// End-to-end acceptance test for the `responder` collaborator role (issue #124).
//
// Every step goes through the HTTP app the way a user would drive it: the
// owner uploads, flips visibility with PATCH /api/documents/:id, and grants
// or changes roles through the collaborators API. Nothing is written to the
// database directly, so the "ghost commenter" (a commenter row left over from
// a private → org flip) arises exactly as it does in production.
//
// The rules under test:
// - writing events needs owner, editor or responder; a commenter can no
//   longer write them;
// - a commenter still READS collaborators- and artifact-audience events,
//   because pages render from those rows;
// - a responder reads, comments and writes events but cannot publish a
//   version, rename the document or edit a version note.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { composeResolvers, makeBearerResolver } from '../auth/bearer.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type {
  ApiTokenScope,
  CollaboratorsListResponse,
  CreateTokenResponse,
  DocumentDetailResponse,
  EventsListResponse,
  SendEventsResponse,
} from '@polygonlabs/primer-api-types';
import { asUser, asUserJson } from './harness.ts';
import { uploadFixture } from '../routes/upload.testlib.ts';

type App = ReturnType<typeof createApp>;

const OWNER = 'mock-user-1'; // uploadFixture uploads as the default mock user
const USER_B = 'mock-user-2';
const USER_C = 'mock-user-3';
const ORG_MEMBER = 'mock-user-4'; // an org member with no collaborator row

async function withMultiUserApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-responder-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: OWNER, email: 'one@p.t', displayName: 'User One' },
        { id: USER_B, email: 'two@p.t', displayName: 'User Two' },
        { id: USER_C, email: 'three@p.t', displayName: 'User Three' },
        { id: ORG_MEMBER, email: 'four@p.t', displayName: 'User Four' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ev = (over: Record<string, unknown> = {}) => ({
  namespace: 'survey',
  type: 'answer',
  payload: { choice: 'a' },
  audience: 'collaborators',
  ...over,
});

async function setVisibility(app: App, docId: string, visibility: 'org' | 'private'): Promise<number> {
  const res = await app.request(`/api/documents/${docId}`, {
    method: 'PATCH',
    headers: asUserJson(OWNER),
    body: JSON.stringify({ visibility }),
  });
  return res.status;
}

async function addCollaborator(app: App, docId: string, userId: string, role: string): Promise<number> {
  const res = await app.request(`/api/documents/${docId}/collaborators`, {
    method: 'POST',
    headers: asUserJson(OWNER),
    body: JSON.stringify({ userId, role }),
  });
  return res.status;
}

async function postEvents(
  app: App,
  docId: string,
  userId: string,
  events: unknown[],
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/api/documents/${docId}/events`, {
    method: 'POST',
    headers: asUserJson(userId),
    body: JSON.stringify({ events }),
  });
  return { status: res.status, body: await res.json() };
}

async function listEvents(app: App, docId: string, userId: string): Promise<{ status: number; ids: number[] }> {
  const res = await app.request(`/api/documents/${docId}/events`, { headers: asUser(userId) });
  if (res.status !== 200) return { status: res.status, ids: [] };
  const body = (await res.json()) as EventsListResponse;
  return { status: res.status, ids: body.events.map((r) => r.id) };
}

async function readDocument(app: App, docId: string, userId: string): Promise<Response> {
  return app.request(`/api/documents/${docId}`, { headers: asUser(userId) });
}

describe('responder role — acceptance', () => {
  it('ghost commenter: a commenter left over from a private → org flip cannot write events but still reads them, until upgraded to responder', async () => {
    await withMultiUserApp(async (app) => {
      // Owner uploads; the document starts org-visible.
      const { documentId } = await uploadFixture(app);

      // Owner makes it private and shares it: B as commenter, C as responder.
      expect(await setVisibility(app, documentId, 'private')).toBe(200);
      expect(await addCollaborator(app, documentId, USER_B, 'commenter')).toBe(201);
      expect(await addCollaborator(app, documentId, USER_C, 'responder')).toBe(201);
      expect((await readDocument(app, documentId, USER_B)).status).toBe(200);
      expect((await readDocument(app, documentId, USER_C)).status).toBe(200);

      // Owner flips back to org. Visibility changes never touch collaborator
      // rows, so B's commenter row stays.
      expect(await setVisibility(app, documentId, 'org')).toBe(200);
      const listRes = await app.request(`/api/documents/${documentId}/collaborators`, {
        headers: asUser(OWNER),
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as CollaboratorsListResponse;
      expect(list.collaborators.find((r) => r.userId === USER_B)).toHaveProperty('role', 'commenter');
      // The responder row round-trips through the list with its role intact.
      expect(list.collaborators.find((r) => r.userId === USER_C)).toHaveProperty('role', 'responder');

      // The leftover commenter row grants no event write; the responder may write.
      expect((await postEvents(app, documentId, USER_B, [ev()])).status).toBe(403);
      const fromC = await postEvents(app, documentId, USER_C, [ev()]);
      expect(fromC.status).toBe(201);
      const written = (fromC.body as SendEventsResponse).events;
      expect(written).toHaveLength(1);
      expect(written[0]).toHaveProperty('authorId', USER_C);
      const cRowId = written[0]?.id;
      expect(cRowId).toBeDefined();

      // B keeps read: C's collaborators-audience row is still visible to B.
      const bRead = await listEvents(app, documentId, USER_B);
      expect(bRead.status).toBe(200);
      expect(bRead.ids).toContain(cRowId);

      // An org member with no collaborator row can neither write nor see it.
      expect((await postEvents(app, documentId, ORG_MEMBER, [ev()])).status).toBe(403);
      const orgRead = await listEvents(app, documentId, ORG_MEMBER);
      expect(orgRead.ids).not.toContain(cRowId);

      // The owner upgrades B to responder through the collaborators API; B may now write.
      const patch = await app.request(`/api/documents/${documentId}/collaborators/${USER_B}`, {
        method: 'PATCH',
        headers: asUserJson(OWNER),
        body: JSON.stringify({ role: 'responder' }),
      });
      expect(patch.status).toBe(200);
      expect((await postEvents(app, documentId, USER_B, [ev()])).status).toBe(201);
    });
  });

  it('responder on a private document: reads, comments and writes events, but cannot publish, rename or edit a version note', async () => {
    await withMultiUserApp(async (app) => {
      const { documentId, versionId } = await uploadFixture(app);
      expect(await setVisibility(app, documentId, 'private')).toBe(200);
      expect(await addCollaborator(app, documentId, USER_C, 'responder')).toBe(201);
      const listRes = await app.request(`/api/documents/${documentId}/collaborators`, { headers: asUser(OWNER) });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as CollaboratorsListResponse;
      expect(list.collaborators.find((r) => r.userId === USER_C)).toHaveProperty('role', 'responder');

      // Read, and the detail reports the role.
      const detailRes = await readDocument(app, documentId, USER_C);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as DocumentDetailResponse;
      expect(detail).toHaveProperty('myRole', 'responder');

      // Comment: open a thread, then list threads.
      const threadRes = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: asUserJson(USER_C),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'fixture', prefix: '', suffix: '', containerPath: 'body' },
          body: 'Looks right to me.',
        }),
      });
      expect(threadRes.status).toBe(201);
      const threadsRes = await app.request(`/api/versions/${versionId}/threads`, { headers: asUser(USER_C) });
      expect(threadsRes.status).toBe(200);

      // Write events.
      expect((await postEvents(app, documentId, USER_C, [ev()])).status).toBe(201);

      // Publish a version: refused.
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body>v2</body></html>'], { type: 'text/html' }), 'v2.html');
      const publish = await app.request(`/api/documents/${documentId}/versions`, {
        method: 'POST',
        headers: asUser(USER_C),
        body: fd,
      });
      expect(publish.status).toBe(403);

      // Rename: refused.
      const rename = await app.request(`/api/documents/${documentId}`, {
        method: 'PATCH',
        headers: asUserJson(USER_C),
        body: JSON.stringify({ title: 'Renamed by a responder' }),
      });
      expect(rename.status).toBe(403);

      // Edit a version note: refused.
      const note = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: asUserJson(USER_C),
        body: JSON.stringify({ versionNote: 'edited by a responder' }),
      });
      expect(note.status).toBe(403);
    });
  });

  it('commenter on a private document: cannot write events, but still reads collaborators- and artifact-audience rows', async () => {
    await withMultiUserApp(async (app) => {
      const { documentId } = await uploadFixture(app);
      expect(await setVisibility(app, documentId, 'private')).toBe(200);
      expect(await addCollaborator(app, documentId, USER_B, 'commenter')).toBe(201);

      // The owner writes one row per readable audience.
      const owned = await postEvents(app, documentId, OWNER, [
        ev({ type: 'shared-state', audience: 'collaborators' }),
        ev({ type: 'page-data', audience: 'artifact' }),
      ]);
      expect(owned.status).toBe(201);
      const ownerRows = (owned.body as SendEventsResponse).events;
      expect(ownerRows).toHaveLength(2);
      const collaboratorsRowId = ownerRows.find((r) => r.audience === 'collaborators')?.id;
      const artifactRowId = ownerRows.find((r) => r.audience === 'artifact')?.id;
      expect(collaboratorsRowId).toBeDefined();
      expect(artifactRowId).toBeDefined();

      // Writing is refused.
      expect((await postEvents(app, documentId, USER_B, [ev()])).status).toBe(403);

      // Reading both audiences still works.
      const bRead = await listEvents(app, documentId, USER_B);
      expect(bRead.status).toBe(200);
      expect(bRead.ids).toContain(collaboratorsRowId);
      expect(bRead.ids).toContain(artifactRowId);
    });
  });
  it('scope ∧ role: an API token scope only narrows what the document role allows', async () => {
    // Token scopes are checked before the handler; the handler's role check
    // still runs. So `events:write` on a commenter's token is refused by the
    // role, and a responder needs both the role and the scope.
    const root = await mkdtemp(join(tmpdir(), 'primer-responder-scopes-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
      });
      await db
        .insert(users)
        .values([
          { id: OWNER, email: 'one@p.t', displayName: 'User One' },
          { id: USER_B, email: 'two@p.t', displayName: 'User Two' },
          { id: USER_C, email: 'three@p.t', displayName: 'User Three' },
        ])
        .onConflictDoNothing();

      const mint = async (userId: string, scopes: ApiTokenScope[]): Promise<string> => {
        const res = await app.request('/api/tokens', {
          method: 'POST',
          headers: asUserJson(userId),
          body: JSON.stringify({ name: `responder-scope-${userId}`, scopes }),
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as CreateTokenResponse).token;
      };
      const bearerPost = async (token: string, docId: string): Promise<Response> =>
        await app.request(`/api/documents/${docId}/events`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ events: [ev()] }),
        });

      const { documentId } = await uploadFixture(app);
      expect(await setVisibility(app, documentId, 'private')).toBe(200);
      expect(await addCollaborator(app, documentId, USER_B, 'commenter')).toBe(201);
      expect(await addCollaborator(app, documentId, USER_C, 'responder')).toBe(201);

      // The owner writes a collaborators-audience row for the read check below.
      const ownerRow = await postEvents(app, documentId, OWNER, [ev()]);
      expect(ownerRow.status).toBe(201);
      const ownerRowId = (ownerRow.body as SendEventsResponse).events[0]?.id;

      // Commenter's token holds events:write, but the role still refuses.
      const commenterWriteToken = await mint(USER_B, ['documents:read', 'events:write']);
      const commenterWrite = await bearerPost(commenterWriteToken, documentId);
      expect(commenterWrite.status).toBe(403);
      expect(((await commenterWrite.json()) as { error: string }).error).toBe('forbidden');

      // Responder with the same scopes may write.
      const responderWriteToken = await mint(USER_C, ['documents:read', 'events:write']);
      expect((await bearerPost(responderWriteToken, documentId)).status).toBe(201);

      // Responder without events:write is stopped by the scope.
      const responderReadToken = await mint(USER_C, ['documents:read']);
      const scoped = await bearerPost(responderReadToken, documentId);
      expect(scoped.status).toBe(403);
      expect(((await scoped.json()) as { error: string }).error).toBe('insufficient_scope');

      // A commenter's read-only token still reads collaborators-audience rows.
      const commenterReadToken = await mint(USER_B, ['documents:read']);
      const readRes = await app.request(`/api/documents/${documentId}/events`, {
        headers: { authorization: `Bearer ${commenterReadToken}` },
      });
      expect(readRes.status).toBe(200);
      const read = (await readRes.json()) as EventsListResponse;
      expect(read.events.map((r) => r.id)).toContain(ownerRowId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
