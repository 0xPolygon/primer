import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { UploadResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { db } from '../db/client.ts';
import { versions } from '../db/schema.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { MOCK_USER } from '../auth/resolver.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { publishDocument, type PublishInput } from './publish.ts';

async function withStorage<T>(fn: (storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-publish-test-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function bytesAt(storage: Storage, key: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await storage.get(key)).arrayBuffer());
}

const enc = (s: string) => new TextEncoder().encode(s);

function md(content: string, extra: Partial<PublishInput> = {}): PublishInput {
  return { actor: MOCK_USER, title: 'Doc', content: enc(content), filename: 'doc.md', format: 'markdown', ...extra };
}

async function publishOk(storage: Storage, input: PublishInput) {
  const r = await publishDocument(storage, input);
  if (!r.ok) throw new Error(`publish refused: ${r.refusal.code}`);
  return r;
}

describe('publishDocument', () => {
  it('stores the uploaded bytes verbatim as the original', async () => {
    await withStorage(async (storage) => {
      const r = await publishOk(storage, md('# Hi\n'));
      const [row] = await db.select().from(versions).where(eq(versions.id, r.versionId));
      expect(row.sourceFormat).toBe('markdown');
      expect(row.originalKey).toBe(`v1/${r.versionId}.orig`);
      expect(await bytesAt(storage, row.originalKey!)).toEqual(enc('# Hi\n'));
    });
  });

  it('stale baseVersionNumber is refused', async () => {
    await withStorage(async (storage) => {
      const v1 = await publishOk(storage, md('# One\n'));
      await publishOk(storage, md('# Two\n', { documentId: v1.documentId, baseVersionNumber: 1 }));

      const r = await publishDocument(storage, md('# Three\n', { documentId: v1.documentId, baseVersionNumber: 1 }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(409);
      expect(r.refusal.code).toBe('stale_base');
      expect(r.refusal.fix).toContain('2');
      const rows = await db.select().from(versions).where(eq(versions.documentId, v1.documentId));
      expect(rows).toHaveLength(2);
    });
  });

  it('concurrent publishes on the same base: exactly one wins', async () => {
    await withStorage(async (storage) => {
      const v1 = await publishOk(storage, md('# One\n'));
      const results = await Promise.all(
        ['# A\n', '# B\n'].map((c) => publishDocument(storage, md(c, { documentId: v1.documentId, baseVersionNumber: 1 }))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.find((r) => !r.ok);
      expect(refused && !refused.ok && refused.refusal.code).toBe('stale_base');
    });
  });

  it('REST and MCP produce identical stored HTML', async () => {
    await withStorage(async (storage) => {
      const source = '# Same\n\nBody text.\n';
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = new FormData();
      fd.append('file', new Blob([source], { type: 'text/markdown' }), 'same.md');
      fd.append('title', 'Same');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(200);
      const rest = (await res.json()) as UploadResponse;

      const handlers = buildMcpToolHandlers({ storage, notifier: new NoopNotifier(), apiBaseUrl: 'https://primer.example.com' });
      const out = await handlers.primer_create_document({ title: 'Same', content: source, format: 'markdown' }, MOCK_USER);
      expect(out.isError).toBeUndefined();
      const mcp = JSON.parse(out.content[0].text) as { versionId: string };

      const keyOf = async (id: string) =>
        (await db.select({ k: versions.storageKey }).from(versions).where(eq(versions.id, id)))[0].k;
      expect(await bytesAt(storage, await keyOf(mcp.versionId))).toEqual(await bytesAt(storage, await keyOf(rest.versionId)));
    });
  });
});
