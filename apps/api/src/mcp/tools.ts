import { z, type ZodTypeAny } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Storage } from '@primer/shared/storage';
import type { Notifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, users } from '@primer/shared/schema';
import { markdownToHtml } from '../upload/markdown.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { parsePrimerUrl } from './urlResolve.ts';
import type { ThreadsListResponse, ThreadDTO, CommentDTO } from '@primer/shared/api';
import { isTextRangeAnchor, isElementPathAnchor } from '@primer/shared';

export type PrimerErrorCode =
  | 'not_authenticated'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'network';

export interface TextContent { type: 'text'; text: string; }
export interface ToolResult { isError?: boolean; content: TextContent[]; }
export type AuthUser = { id: string; email: string; displayName: string };
export type ToolHandler = (args: Record<string, unknown>, user: AuthUser) => Promise<ToolResult>;

export interface ToolDeps {
  storage: Storage;
  notifier: Notifier;
  apiBaseUrl: string;   // used to render doc URLs in tool responses
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function err(code: PrimerErrorCode, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] };
}

// Inline port of apps/mcp/src/format.ts — avoids cross-package import.
function formatCommentsMarkdown(
  threadsResponse: ThreadsListResponse,
  docTitle?: string,
  versionNumber?: number,
): string {
  const list = threadsResponse.threads;
  if (list.length === 0) return 'No comments on this version.';

  const header =
    docTitle !== undefined && versionNumber !== undefined
      ? `# Comments on ${docTitle} (v${versionNumber})`
      : '# Comments';

  const open = list.filter((t) => t.resolvedAt === null).length;
  const resolved = list.length - open;
  const counts = `Threads: ${list.length} (open: ${open}, resolved: ${resolved})`;

  const sections = list.map((thread: ThreadDTO) => {
    const anchor = thread.anchor;
    let quote: string;
    if (isTextRangeAnchor(anchor)) {
      quote = anchor.selectorText;
    } else if (isElementPathAnchor(anchor)) {
      quote = anchor.innerText && anchor.innerText.length > 0 ? anchor.innerText : '(no quote)';
    } else {
      quote = '(no quote)';
    }
    const badge = thread.resolvedAt === null ? '[open]' : '[resolved]';
    const commentLines = thread.comments.map((c: CommentDTO) => {
      if (c.deletedAt !== null) return '(deleted)';
      return `**${c.authorDisplayName}** — ${c.body} (${c.createdAt})`;
    });
    return [`> ${quote}`, badge, ...commentLines, ''].join('\n');
  });

  return [header, counts, '', ...sections].join('\n').trimEnd() + '\n';
}

export const TOOL_NAMES = [
  'primer_whoami',
  'primer_get_document',
  'primer_get_version_content',
  'primer_list_versions',
  'primer_get_comments',
  'primer_create_document',
  'primer_add_version',
  'primer_resolve_url',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function buildMcpToolHandlers(deps: ToolDeps): Record<ToolName, ToolHandler> {
  return {
    primer_whoami: async (_args, user) => ok(user),

    primer_resolve_url: async (args) => {
      const url = typeof args.url === 'string' ? args.url : '';
      const parsed = parsePrimerUrl(url);
      if (!parsed) return err('bad_request', 'not a Primer URL');
      return ok(parsed);
    },

    primer_get_document: async (args, _user) => {
      // Accepts { documentId } OR { url }.
      let documentId: string | undefined;
      if (typeof args.documentId === 'string' && args.documentId.length > 0) {
        documentId = args.documentId;
      } else if (typeof args.url === 'string') {
        const parsed = parsePrimerUrl(args.url);
        if (!parsed) return err('bad_request', 'not a Primer URL');
        documentId = parsed.documentId;
      } else {
        return err('bad_request', 'documentId or url is required');
      }

      // Mirror GET /api/documents/:docId from routes/documents.ts.
      // No ownership gate — Primer is share-by-URL, any authenticated user can read.
      const docRows = await db
        .select({
          id: documents.id,
          title: documents.title,
          description: documents.description,
          uploaderId: documents.uploaderId,
          createdAt: documents.createdAt,
          deletedAt: documents.deletedAt,
          uploaderDisplayName: users.displayName,
        })
        .from(documents)
        .innerJoin(users, eq(users.id, documents.uploaderId))
        .where(eq(documents.id, documentId))
        .limit(1);

      if (docRows.length === 0) return err('not_found', 'document not found');
      if (docRows[0].deletedAt !== null) return err('not_found', 'document not found');

      const versionRows = await db
        .select()
        .from(versions)
        .where(eq(versions.documentId, documentId))
        .orderBy(desc(versions.versionNumber))
        .limit(1);

      if (versionRows.length === 0) return err('not_found', 'document has no versions');

      const doc = docRows[0];
      const v = versionRows[0];

      return ok({
        document: {
          id: doc.id,
          title: doc.title,
          description: doc.description,
          uploaderId: doc.uploaderId,
          uploaderDisplayName: doc.uploaderDisplayName,
          createdAt: doc.createdAt.toISOString(),
        },
        latestVersion: {
          id: v.id,
          versionNumber: v.versionNumber,
          versionNote: v.versionNote,
          sizeBytes: v.sizeBytes,
          createdAt: v.createdAt.toISOString(),
        },
      });
    },

    primer_get_version_content: async (args, _user) => {
      // Accepts { versionId } OR { documentId } (latest) OR { url } (specific or latest).
      // No ownership gate — mirrors GET /api/versions/:versionId/content (share-by-URL model).
      let versionId: string | undefined;
      let documentId: string | undefined;
      let requestedVersionNumber: number | undefined;

      if (typeof args.versionId === 'string' && args.versionId.length > 0) {
        versionId = args.versionId;
      } else if (typeof args.documentId === 'string' && args.documentId.length > 0) {
        documentId = args.documentId;
      } else if (typeof args.url === 'string') {
        const parsed = parsePrimerUrl(args.url);
        if (!parsed) return err('bad_request', 'not a Primer URL');
        documentId = parsed.documentId;
        requestedVersionNumber = parsed.versionNumber;
      } else {
        return err('bad_request', 'versionId, documentId, or url is required');
      }

      // Resolve versionId if we only have documentId (± requestedVersionNumber).
      if (!versionId) {
        const [existingDoc] = await db
          .select({ deletedAt: documents.deletedAt })
          .from(documents)
          .where(eq(documents.id, documentId!));
        if (!existingDoc) return err('not_found', 'document not found');
        if (existingDoc.deletedAt !== null) return err('not_found', 'document not found');

        if (requestedVersionNumber !== undefined) {
          const [v] = await db
            .select({ id: versions.id })
            .from(versions)
            .where(and(eq(versions.documentId, documentId!), eq(versions.versionNumber, requestedVersionNumber)))
            .limit(1);
          if (!v) return err('not_found', `version ${requestedVersionNumber} not found`);
          versionId = v.id;
        } else {
          const [latest] = await db
            .select({ id: versions.id })
            .from(versions)
            .where(eq(versions.documentId, documentId!))
            .orderBy(desc(versions.versionNumber))
            .limit(1);
          if (!latest) return err('not_found', 'document has no versions');
          versionId = latest.id;
        }
      }

      // Load the version row + soft-delete check via JOIN, same shape as
      // apps/api/src/routes/versionContent.ts.
      const [row] = (await db.execute(sql`
        SELECT v.storage_key AS "storageKey", v.document_id AS "documentId",
               v.version_number AS "versionNumber", v.size_bytes AS "sizeBytes",
               d.deleted_at AS "deletedAt"
        FROM versions v
        INNER JOIN documents d ON d.id = v.document_id
        WHERE v.id = ${versionId}
        LIMIT 1
      `)) as unknown as {
        storageKey: string;
        documentId: string;
        versionNumber: number;
        sizeBytes: number | string;
        deletedAt: Date | null;
      }[];
      if (!row) return err('not_found', 'version not found');
      if (row.deletedAt !== null) return err('not_found', 'version not found');

      const stream = await deps.storage.get(row.storageKey);
      const html = await new Response(stream).text();

      return ok({
        documentId: row.documentId,
        versionId,
        versionNumber: row.versionNumber,
        sizeBytes: typeof row.sizeBytes === 'string' ? Number(row.sizeBytes) : row.sizeBytes,
        content: html,
      });
    },

    primer_list_versions: async (args, _user) => {
      // Mirror GET /api/documents/:docId/versions from routes/documents.ts.
      const documentId = typeof args.documentId === 'string' ? args.documentId : '';
      if (!documentId) return err('bad_request', 'documentId is required');

      const [existingDoc] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, documentId));
      if (!existingDoc) return err('not_found', 'document not found');
      if (existingDoc.deletedAt !== null) return err('not_found', 'document not found');

      const rows = await db
        .select({
          id: versions.id,
          versionNumber: versions.versionNumber,
          versionNote: versions.versionNote,
          sizeBytes: versions.sizeBytes,
          createdAt: versions.createdAt,
        })
        .from(versions)
        .where(eq(versions.documentId, documentId))
        .orderBy(sql`${versions.versionNumber} DESC`);

      return ok({
        versions: rows.map((r) => ({
          id: r.id,
          versionNumber: r.versionNumber,
          versionNote: r.versionNote,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },

    primer_get_comments: async (args, _user) => {
      // Mirror GET /api/versions/:versionId/threads from routes/threads.ts.
      // Accepts { versionId } OR { documentId } (resolves to latest version).
      let versionId: string | undefined;
      let docTitle: string | undefined;
      let versionNumber: number | undefined;

      if (typeof args.versionId === 'string' && args.versionId.length > 0) {
        versionId = args.versionId;
      } else if (typeof args.documentId === 'string' && args.documentId.length > 0) {
        const docId = args.documentId;
        // Resolve to latest version
        const [latestVersion] = await db
          .select({ id: versions.id, versionNumber: versions.versionNumber })
          .from(versions)
          .where(eq(versions.documentId, docId))
          .orderBy(desc(versions.versionNumber))
          .limit(1);
        if (!latestVersion) return err('not_found', 'document has no versions');
        versionId = latestVersion.id;
        versionNumber = latestVersion.versionNumber;

        // Also fetch the document title
        const [doc] = await db
          .select({ title: documents.title })
          .from(documents)
          .where(eq(documents.id, docId))
          .limit(1);
        if (doc) docTitle = doc.title;
      } else {
        return err('bad_request', 'versionId or documentId is required');
      }

      // Load thread + comment rows, same query shape as routes/threads.ts
      interface ThreadRow {
        id: string;
        versionId: string;
        anchor: unknown;
        resolvedAt: Date | null;
        resolvedBy: string | null;
        resolvedByDisplayName: string | null;
        createdAt: Date;
      }
      interface CommentRow {
        id: string;
        threadId: string;
        authorId: string;
        authorDisplayName: string;
        body: string;
        mentions: string[];
        createdAt: Date;
        updatedAt: Date | null;
        deletedAt: Date | null;
      }

      const threadRows = (await db
        .select({
          id: threads.id,
          versionId: threads.versionId,
          anchor: threads.anchor,
          resolvedAt: threads.resolvedAt,
          resolvedBy: threads.resolvedBy,
          resolvedByDisplayName: users.displayName,
          createdAt: threads.createdAt,
        })
        .from(threads)
        .leftJoin(users, eq(users.id, threads.resolvedBy))
        .where(eq(threads.versionId, versionId))
        .orderBy(threads.createdAt)) as ThreadRow[];

      const commentRows: CommentRow[] =
        threadRows.length === 0
          ? []
          : ((await db
              .select({
                id: comments.id,
                threadId: comments.threadId,
                authorId: comments.authorId,
                authorDisplayName: users.displayName,
                body: comments.body,
                mentions: comments.mentions,
                createdAt: comments.createdAt,
                updatedAt: comments.updatedAt,
                deletedAt: comments.deletedAt,
              })
              .from(comments)
              .innerJoin(users, eq(users.id, comments.authorId))
              .where(
                sql`${comments.threadId} IN (${sql.join(
                  threadRows.map((t) => sql`${t.id}`),
                  sql`, `
                )})`
              )
              .orderBy(comments.createdAt)) as CommentRow[]);

      const commentsByThread = new Map<string, CommentRow[]>();
      for (const cr of commentRows) {
        const list = commentsByThread.get(cr.threadId);
        if (list) list.push(cr);
        else commentsByThread.set(cr.threadId, [cr]);
      }

      const threadDTOs: ThreadDTO[] = threadRows.map((t) => ({
        id: t.id,
        versionId: t.versionId,
        anchor: t.anchor as ThreadDTO['anchor'],
        resolvedAt: t.resolvedAt?.toISOString() ?? null,
        resolvedBy: t.resolvedBy,
        resolvedByDisplayName: t.resolvedByDisplayName,
        createdAt: t.createdAt.toISOString(),
        comments: (commentsByThread.get(t.id) ?? []).map((c) => ({
          id: c.id,
          threadId: c.threadId,
          authorId: c.authorId,
          authorDisplayName: c.authorDisplayName,
          body: c.deletedAt !== null ? '' : c.body,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt?.toISOString() ?? null,
          deletedAt: c.deletedAt?.toISOString() ?? null,
          mentions: c.mentions,
        })),
      }));

      const threadsResponse: ThreadsListResponse = {
        threads: threadDTOs,
        asOf: new Date().toISOString(),
      };

      const markdown = formatCommentsMarkdown(threadsResponse, docTitle, versionNumber);
      return ok({ markdown, threadCount: threadDTOs.length });
    },

    primer_create_document: async (args, user) => {
      // Mirror POST /api/upload from routes/upload.ts, but with inline content.
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const description = typeof args.description === 'string' ? args.description.trim() || undefined : undefined;
      const content = typeof args.content === 'string' ? args.content : '';
      const format = args.format === 'markdown' ? 'markdown' : 'html';

      if (!title) return err('bad_request', 'title is required');
      if (!content) return err('bad_request', 'content is required');

      let preparedHtml: string;
      if (format === 'markdown') {
        let mdResult;
        try {
          mdResult = markdownToHtml(content);
        } catch (e) {
          return err('bad_request', `Markdown conversion failed: ${(e as Error).message}`);
        }
        if (mdResult.bodyIsEmpty) {
          return err('bad_request', 'Document body is empty.');
        }
        preparedHtml = mdResult.html;
      } else {
        preparedHtml = content;
      }

      const transformed = transformHtml(preparedHtml);
      if (!transformed.ok) {
        return err('bad_request', transformed.message);
      }

      const documentId = uuidv7();
      const versionId = uuidv7();
      // Storage key format must match upload.ts exactly: v1/<versionId>.html
      const storageKey = `v1/${versionId}.html`;
      const transformedBytes = new TextEncoder().encode(transformed.html);

      await deps.storage.put(storageKey, transformedBytes);

      try {
        await db.transaction(async (tx) => {
          await tx.insert(documents).values({
            id: documentId,
            title,
            description: description ?? null,
            uploaderId: user.id,
          });
          await tx.insert(versions).values({
            id: versionId,
            documentId,
            versionNumber: 1,
            storageKey,
            sizeBytes: transformedBytes.byteLength,
            versionNote: null,
          });
        });
      } catch (e) {
        try { await deps.storage.delete(storageKey); } catch {}
        return err('bad_request', 'Failed to persist document.');
      }

      return ok({
        documentId,
        versionId,
        versionNumber: 1,
        url: `${deps.apiBaseUrl}/d/${documentId}`,
      });
    },

    primer_add_version: async (args, user) => {
      // Mirror POST /api/documents/:docId/versions from routes/documents.ts.
      const documentId = typeof args.documentId === 'string' ? args.documentId : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const format = args.format === 'markdown' ? 'markdown' : 'html';
      const versionNoteRaw = typeof args.versionNote === 'string' ? args.versionNote.trim() : null;

      if (!documentId) return err('bad_request', 'documentId is required');
      if (!content) return err('bad_request', 'content is required');

      const [existingDoc] = await db
        .select({ uploaderId: documents.uploaderId, deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, documentId));
      if (!existingDoc) return err('not_found', 'document not found');
      if (existingDoc.deletedAt !== null) return err('not_found', 'document not found');
      if (existingDoc.uploaderId !== user.id) return err('forbidden', 'only the document owner can add versions');

      let preparedHtml: string;
      if (format === 'markdown') {
        let mdResult;
        try {
          mdResult = markdownToHtml(content);
        } catch (e) {
          return err('bad_request', `Markdown conversion failed: ${(e as Error).message}`);
        }
        if (mdResult.bodyIsEmpty) {
          return err('bad_request', 'Document body is empty.');
        }
        preparedHtml = mdResult.html;
      } else {
        preparedHtml = content;
      }

      const transformed = transformHtml(preparedHtml);
      if (!transformed.ok) {
        return err('bad_request', transformed.message);
      }

      let versionNote: string | null = null;
      if (versionNoteRaw && versionNoteRaw.length > 0) {
        if (versionNoteRaw.length > 500) {
          return err('bad_request', 'versionNote must be ≤500 chars');
        }
        versionNote = versionNoteRaw;
      }

      const versionId = uuidv7();
      const storageKey = `v1/${versionId}.html`;
      const transformedBytes = new TextEncoder().encode(transformed.html);

      const [maxRow] = (await db.execute(sql`
        SELECT COALESCE(MAX(version_number), 0)::int AS max_n
        FROM versions
        WHERE document_id = ${documentId}
      `)) as unknown as { max_n: number }[];
      const nextNumber = (maxRow?.max_n ?? 0) + 1;

      await deps.storage.put(storageKey, transformedBytes);

      try {
        await db.insert(versions).values({
          id: versionId,
          documentId,
          versionNumber: nextNumber,
          storageKey,
          sizeBytes: transformedBytes.byteLength,
          versionNote,
        });
      } catch (e) {
        try { await deps.storage.delete(storageKey); } catch {}
        const pgErr = e as { code?: string };
        if (pgErr.code === '23505') {
          return err('bad_request', 'Concurrent version write; retry.');
        }
        return err('bad_request', 'Failed to persist version.');
      }

      return ok({
        versionId,
        versionNumber: nextNumber,
        url: `${deps.apiBaseUrl}/d/${documentId}`,
      });
    },
  };
}

export const TOOL_CONFIGS: Record<ToolName, { description: string; inputSchema: Record<string, ZodTypeAny> }> = {
  primer_whoami: {
    description: 'Return the authenticated Primer user (id, email, displayName).',
    inputSchema: {},
  },
  primer_resolve_url: {
    description: 'Parse a Primer document URL and return { documentId, versionNumber? }.',
    inputSchema: { url: z.string() },
  },
  primer_get_document: {
    description: 'Fetch a Primer document by documentId OR by its URL.',
    inputSchema: { documentId: z.string().optional(), url: z.string().optional() },
  },
  primer_get_version_content: {
    description:
      'Fetch the raw HTML content of a Primer version. Accepts a versionId, a documentId (returns latest version), or a Primer URL (specific /v/<n> or latest).',
    inputSchema: {
      versionId: z.string().optional(),
      documentId: z.string().optional(),
      url: z.string().optional(),
    },
  },
  primer_list_versions: {
    description: 'List all versions of a Primer document, newest first.',
    inputSchema: { documentId: z.string() },
  },
  primer_get_comments: {
    description: 'Fetch comment threads on a version (or latest version of a document) as a markdown summary.',
    inputSchema: { versionId: z.string().optional(), documentId: z.string().optional() },
  },
  primer_create_document: {
    description: 'Create a new Primer document and upload the initial version. Returns the doc URL.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      content: z.string(),
      format: z.enum(['html', 'markdown']),
    },
  },
  primer_add_version: {
    description: 'Upload a new version of an existing Primer document.',
    inputSchema: {
      documentId: z.string(),
      content: z.string(),
      format: z.enum(['html', 'markdown']),
      versionNote: z.string().optional(),
    },
  },
};
