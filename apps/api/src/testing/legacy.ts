import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documents, versions } from '../db/schema.ts';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';

/**
 * A document from before live documents: format null, one version-only HTML
 * version rendered as the old upload path did. Publishing makes documents
 * live now, so tests of legacy behaviour (version threads, the first live
 * version of a legacy document) start from this.
 */
export async function createLegacyDocument(
  storage: Storage,
  html: string,
  opts: { uploaderId?: string; title?: string; visibility?: 'org' | 'private' } = {},
): Promise<{ documentId: string; versionId: string; versionNumber: number }> {
  const served = transformHtml(html);
  if (!served.ok) throw new Error(served.message);
  const documentId = uuidv7();
  const versionId = uuidv7();
  const storageKey = `v1/${versionId}.html`;
  const bytes = new TextEncoder().encode(served.html);
  await storage.put(storageKey, bytes);
  await db.insert(documents).values({
    id: documentId,
    title: opts.title ?? 'Legacy doc',
    uploaderId: opts.uploaderId ?? 'mock-user-1',
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
  });
  await db.insert(versions).values({ id: versionId, documentId, versionNumber: 1, storageKey, sizeBytes: bytes.byteLength, sourceFormat: 'html' });
  return { documentId, versionId, versionNumber: 1 };
}
