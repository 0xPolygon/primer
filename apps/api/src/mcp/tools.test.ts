import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { documents, users, versions } from '@primer/shared/schema';
import { buildMcpToolHandlers, type ToolDeps } from './tools.ts';

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
}

async function withDeps<T>(fn: (deps: ToolDeps) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-mcp-tools-'));
  try {
    const storage = new FilesystemStorage(root);
    const notifier = new NoopNotifier();
    return await fn({ storage, notifier, apiBaseUrl: 'https://primer.example.com' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM comments`);
  await db.execute(sql`DELETE FROM threads`);
  await db.execute(sql`DELETE FROM versions`);
  await db.execute(sql`DELETE FROM documents`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'tools-%'`);
});

describe('primer_whoami', () => {
  it('returns the user', async () => {
    await seedUser('tools-1');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_whoami({}, { id: 'tools-1', email: 'tools-1@x.test', displayName: 'tools-1' });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.id).toBe('tools-1');
    });
  });
});

describe('primer_resolve_url', () => {
  it('extracts document + version from a Primer URL', async () => {
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_resolve_url(
        { url: 'https://primer.example.com/d/abc-123/v/2' },
        { id: 'tools-x', email: 'x@x.test', displayName: 'x' },
      );
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.documentId).toBe('abc-123');
      expect(parsed.versionNumber).toBe(2);
    });
  });

  it('returns bad_request on a non-Primer URL', async () => {
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_resolve_url(
        { url: 'https://example.com/foo' },
        { id: 'tools-x', email: 'x@x.test', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });
});

describe('primer_create_document → primer_get_document (URL mode)', () => {
  it('creates a doc and reads it back by its URL', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const user = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

      const created = await handlers.primer_create_document(
        {
          title: 'Hello',
          content: '# hi',
          format: 'markdown',
        },
        user,
      );
      const createdBody = JSON.parse(created.content[0].text);
      expect(createdBody.documentId).toBeTruthy();
      expect(createdBody.url).toContain('/d/');

      const fetched = await handlers.primer_get_document(
        { url: createdBody.url },
        user,
      );
      const fetchedBody = JSON.parse(fetched.content[0].text);
      expect(fetchedBody.document.title).toBe('Hello');
    });
  });
});

describe('primer_get_document — open access path', () => {
  // Ownership rule: GET /api/documents/:docId has NO ownership gate —
  // any authenticated user can read a document (Primer is share-by-URL).
  // This test confirms the tool preserves that open-access model.
  it('returns the document for a different authenticated user', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'Private', content: '<p>hi</p>', format: 'html' },
        { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' },
      );
      const { documentId } = JSON.parse(created.content[0].text);
      const res = await handlers.primer_get_document(
        { documentId },
        { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' },
      );
      // Open access: other user can read
      expect(res.isError).toBeFalsy();
      expect(res).toBeDefined();
    });
  });
});

describe('primer_get_version_content', () => {
  const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

  it('returns HTML content when given a versionId', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C1', content: '<p>hello world</p>', format: 'html' },
        owner,
      );
      const { versionId, documentId } = JSON.parse(created.content[0].text);

      const res = await handlers.primer_get_version_content({ versionId }, owner);
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body.documentId).toBe(documentId);
      expect(body.versionId).toBe(versionId);
      expect(body.versionNumber).toBe(1);
      expect(typeof body.sizeBytes).toBe('number');
      expect(body.content).toContain('hello world');
    });
  });

  it('returns the latest version when given only documentId', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C2', content: '<p>v1 body</p>', format: 'html' },
        owner,
      );
      const { documentId } = JSON.parse(created.content[0].text);

      const v2 = await handlers.primer_add_version(
        { documentId, content: '<p>v2 body</p>', format: 'html' },
        owner,
      );
      const { versionId: v2Id } = JSON.parse(v2.content[0].text);

      const res = await handlers.primer_get_version_content({ documentId }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.versionId).toBe(v2Id);
      expect(body.versionNumber).toBe(2);
      expect(body.content).toContain('v2 body');
    });
  });

  it('returns a specific version when given a URL with /v/<n>', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C3', content: '<p>v1 body</p>', format: 'html' },
        owner,
      );
      const { documentId, versionId: v1Id, url } = JSON.parse(created.content[0].text);
      await handlers.primer_add_version(
        { documentId, content: '<p>v2 body</p>', format: 'html' },
        owner,
      );

      const res = await handlers.primer_get_version_content({ url: `${url}/v/1` }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.versionId).toBe(v1Id);
      expect(body.versionNumber).toBe(1);
      expect(body.content).toContain('v1 body');
    });
  });

  it('returns latest when given a URL without /v/<n>', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C4', content: '<p>v1 body</p>', format: 'html' },
        owner,
      );
      const { documentId, url } = JSON.parse(created.content[0].text);
      const v2 = await handlers.primer_add_version(
        { documentId, content: '<p>v2 body</p>', format: 'html' },
        owner,
      );
      const { versionId: v2Id } = JSON.parse(v2.content[0].text);

      const res = await handlers.primer_get_version_content({ url }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.versionId).toBe(v2Id);
      expect(body.versionNumber).toBe(2);
      expect(body.content).toContain('v2 body');
    });
  });

  it('returns bad_request when no input given', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_version_content({}, owner);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it('returns bad_request on a malformed URL', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_version_content(
        { url: 'not a Primer URL' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it('returns not_found for an unknown versionId', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_version_content(
        { versionId: '00000000-0000-0000-0000-000000000000' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });

  it('returns not_found when the URL specifies a versionNumber that does not exist', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C5', content: '<p>only v1</p>', format: 'html' },
        owner,
      );
      const { url } = JSON.parse(created.content[0].text);
      const res = await handlers.primer_get_version_content({ url: `${url}/v/9` }, owner);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });
});
