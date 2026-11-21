// The one publish path. REST (`POST /api/upload`, `POST
// /api/documents/:docId/versions`) and MCP (`primer_create_document`,
// `primer_add_version`) are thin adapters over `publishDocument`, so the two
// can't drift.
//
// Every publish keeps the uploaded bytes verbatim (`v1/<versionId>.orig`)
// next to the rendered HTML. The new version number and the optional
// `baseVersionNumber` check run inside the transaction, after locking the
// document row, so two publishes on the same base can't both win.
//
// The version row, the carried threads and `primer.version.published` commit
// together. Carried placements emit no event of their own: they are part of
// the version, and a reader that sees version.published lists the new
// version's threads.
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { PublishFormat, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, versions } from '../db/schema.ts';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { markdownToHtml, textToHtml } from '../upload/markdown.ts';
import { MAX_BYTES, MAX_DESCRIPTION, MAX_TITLE } from '../upload/validate.ts';
import { transactionWithEvents } from './events.ts';
import { canEdit, canRead, loadEffectiveRole, type Visibility } from './permissions.ts';
import { carryOpenThreads, loadCarryOrigins } from './threadCarry.ts';

export const MAX_VERSION_NOTE = 500;

export interface PublishInput {
  actor: AuthUser;
  /** Absent: create a new document (needs `title`). Present: add a version. */
  documentId?: string;
  title?: string;
  description?: string | null;
  content: Uint8Array;
  filename: string;
  format: PublishFormat;
  versionNote?: string | null;
  /** The version the caller read. When set and the document has moved on,
   *  the publish is refused with `stale_base`. */
  baseVersionNumber?: number;
}

export type PublishResult =
  | { ok: true; documentId: string; versionId: string; versionNumber: number }
  | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };

/** `details.error` keeps the REST error code clients already branch on. */
function refuse(
  status: 400 | 403 | 404 | 409,
  code: Refusal['code'],
  message: string,
  fix: string,
  restError: string = code,
): PublishResult {
  return { ok: false, status, refusal: { code, message, fix, details: { error: restError } } };
}

class StaleBase extends Error {
  constructor(readonly latest: number) {
    super('stale base');
  }
}

function render(format: PublishFormat, text: string): { ok: true; html: string } | { ok: false; message: string } {
  if (format === 'html') {
    const t = transformHtml(text);
    return t.ok ? { ok: true, html: t.html } : { ok: false, message: t.message };
  }
  let prepared: { html: string; bodyIsEmpty: boolean };
  try {
    prepared = format === 'markdown' ? markdownToHtml(text) : textToHtml(text);
  } catch (err) {
    return { ok: false, message: `Markdown conversion failed: ${(err as Error).message}` };
  }
  if (prepared.bodyIsEmpty) return { ok: false, message: 'Document body is empty.' };
  // Primer authored this HTML, so the parent app owns its theme.
  const t = transformHtml(prepared.html, { themeManaged: true });
  return t.ok ? { ok: true, html: t.html } : { ok: false, message: t.message };
}

export async function publishDocument(storage: Storage, input: PublishInput): Promise<PublishResult> {
  const { actor, documentId: existingId } = input;

  if (input.content.byteLength > MAX_BYTES) {
    return refuse(400, 'bad_request', `File exceeds the ${MAX_BYTES}-byte limit.`, 'Publish a smaller file.', 'too_large');
  }

  let title: string | undefined;
  let description: string | null = null;
  if (existingId === undefined) {
    title = (input.title ?? '').trim();
    if (title.length === 0 || title.length > MAX_TITLE) {
      return refuse(400, 'bad_request', `Title must be 1–${MAX_TITLE} characters.`, 'Pass a non-empty title.', 'missing_title');
    }
    description = input.description?.trim() || null;
    if (description !== null && description.length > MAX_DESCRIPTION) {
      return refuse(400, 'bad_request', `Description must be ${MAX_DESCRIPTION} characters or fewer.`, 'Shorten the description.', 'validation_failed');
    }
  } else {
    const [doc] = await db
      .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, existingId));
    const notFound = refuse(404, 'not_found', 'Document not found.', 'Check the document id, or create a new document.');
    if (!doc || doc.deletedAt !== null) return notFound;
    const eff = await loadEffectiveRole({ id: existingId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, actor);
    if (!canRead(doc.visibility as Visibility, eff)) return notFound;
    if (!canEdit(eff)) {
      return refuse(403, 'forbidden', 'Only the document owner or an editor can add versions.', 'Ask the owner for editor access, or leave a comment instead.');
    }
  }

  const versionNote = input.versionNote?.trim() || null;
  if (versionNote !== null && versionNote.length > MAX_VERSION_NOTE) {
    return refuse(400, 'bad_request', `versionNote must be ≤${MAX_VERSION_NOTE} chars.`, 'Shorten the version note.', 'invalid_body');
  }

  const rendered = render(input.format, new TextDecoder('utf-8').decode(input.content));
  if (!rendered.ok) return refuse(400, 'bad_request', rendered.message, 'Fix the content and publish again.', 'parse_failed');

  const documentId = existingId ?? uuidv7();
  const versionId = uuidv7();
  const storageKey = `v1/${versionId}.html`;
  const originalKey = `v1/${versionId}.orig`;
  const htmlBytes = new TextEncoder().encode(rendered.html);
  const origins = existingId === undefined ? new Map() : await loadCarryOrigins(storage, documentId);

  const cleanup = async () => {
    for (const key of [storageKey, originalKey]) {
      try { await storage.delete(key); } catch {}
    }
  };
  try {
    await storage.put(storageKey, htmlBytes);
    await storage.put(originalKey, input.content);
  } catch (e) {
    await cleanup();
    throw e;
  }

  let versionNumber: number;
  try {
    versionNumber = await transactionWithEvents(async (tx, emit) => {
      let next = 1;
      if (existingId === undefined) {
        await tx.insert(documents).values({ id: documentId, title: title!, description, uploaderId: actor.id });
      } else {
        // NO KEY UPDATE still serialises version allocation but does not conflict with the KEY SHARE
        // an events writer takes (FK check) while holding the events lock.
        await tx.execute(sql`SELECT id FROM documents WHERE id = ${documentId} FOR NO KEY UPDATE`);
        const [row] = (await tx.execute(sql`
          SELECT COALESCE(MAX(version_number), 0)::int AS latest FROM versions WHERE document_id = ${documentId}
        `)) as unknown as { latest: number }[];
        const latest = row?.latest ?? 0;
        if (input.baseVersionNumber !== undefined && input.baseVersionNumber !== latest) throw new StaleBase(latest);
        next = latest + 1;
      }
      await tx.insert(versions).values({
        id: versionId,
        documentId,
        versionNumber: next,
        storageKey,
        sizeBytes: htmlBytes.byteLength,
        versionNote,
        originalKey,
        sourceFormat: input.format,
      });
      if (existingId !== undefined) {
        await carryOpenThreads(tx, storage, { documentId, versionId, html: rendered.html, origins });
      }
      emit({
        documentId,
        versionId,
        actorId: actor.id,
        type: 'version.published',
        payload: { document_id: documentId, version_id: versionId, number: next, author_id: actor.id },
      });
      return next;
    });
  } catch (err) {
    await cleanup();
    if (err instanceof StaleBase) {
      return refuse(
        409,
        'stale_base',
        `The document is at version ${err.latest}, not ${input.baseVersionNumber}.`,
        `Read version ${err.latest}, merge your changes into it, and publish again with baseVersionNumber ${err.latest}.`,
      );
    }
    throw err;
  }

  return { ok: true, documentId, versionId, versionNumber };
}
