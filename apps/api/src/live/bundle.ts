import * as Y from 'yjs';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { comments, docFiles, threads } from '../db/schema.ts';
import type { DocumentFormat } from '@polygonlabs/primer-api-types';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { readBlocks } from './editor.ts';
import { exportHtml, exportMarkdown, exportText, type FileResolver } from './export.ts';
import { tabsOf } from './reach.ts';

/**
 * A checkpoint's render bundle (C11): everything shares, previews, print,
 * exports, compare and restore read, rendered once from one frozen state and
 * never changed. Stored under `bundles/<versionId>/`.
 *
 * - `state.ydoc`: the Y.Doc state the bundle was rendered from;
 * - `export.md` or `export.txt` (the document's own format) and `export.html`;
 * - `static.html`: the static rendering, served like any version's content;
 * - `threads.json`: the open threads at capture with their quotes and comment
 *   counts, so the checkpoint keeps its discussion context;
 * - `files.json`: the ids of the files the content references.
 *
 * Later milestones add `pages/`, `widgets/` and `records.json`.
 */
export type BundleManifest = { versionId: string; format: string; files: string[] };

/** The open threads of a document as a checkpoint keeps them. */
export type BundleThread = {
  threadId: string;
  quote: string;
  commentCount: number;
  createdAt: string;
};

export function bundleKeyOf(versionId: string): string {
  return `bundles/${versionId}/`;
}

/** The export file a document format keeps in its bundle. */
export function exportFileOf(format: string): 'export.md' | 'export.txt' {
  return format === 'text' ? 'export.txt' : 'export.md';
}

export async function renderBundle(
  storage: Storage,
  opts: { versionId: string; documentId: string; title: string; state: Uint8Array; format: DocumentFormat },
): Promise<{ bundleKey: string; staticKey: string; staticBytes: number; staticHtml: string }> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, opts.state);
  try {
    // The document row is the authority: the Y.Doc's meta is writable by every editor.
    const { format } = opts;
    const html = await exportHtml(doc, opts.title, storedFiles(storage, opts.documentId));
    const served = transformHtml(html, { themeManaged: true });
    if (!served.ok) throw new Error(`static rendering failed: ${served.message}`);
    const exported = format === 'text' ? exportText(doc, opts.documentId) : await exportMarkdown(doc, opts.documentId);
    const files: Record<string, string | Uint8Array> = {
      'state.ydoc': opts.state,
      [exportFileOf(format)]: exported,
      'export.html': html,
      'static.html': served.html,
      'threads.json': JSON.stringify(await openThreads(opts.documentId)),
      'files.json': JSON.stringify(await referencedFiles(doc, opts.documentId)),
    };
    const manifest: BundleManifest = { versionId: opts.versionId, format, files: Object.keys(files) };
    files['manifest.json'] = JSON.stringify(manifest);

    const key = bundleKeyOf(opts.versionId);
    const encoder = new TextEncoder();
    let staticBytes = 0;
    try {
      for (const [name, content] of Object.entries(files)) {
        const bytes = typeof content === 'string' ? encoder.encode(content) : content;
        if (name === 'static.html') staticBytes = bytes.byteLength;
        await storage.put(key + name, bytes);
      }
    } catch (err) {
      // Don't leave the files that did land behind.
      await deleteBundle(storage, key);
      throw err;
    }
    return { bundleKey: key, staticKey: `${key}static.html`, staticBytes, staticHtml: served.html };
  } finally {
    doc.destroy();
  }
}

export async function readBundleFile(storage: Storage, bundleKey: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(await storage.get(bundleKey + name)).arrayBuffer());
}

/** The bundle's frozen Y.Doc. */
export async function loadBundleDoc(storage: Storage, bundleKey: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await readBundleFile(storage, bundleKey, 'state.ydoc'));
  return doc;
}

/** Every storage key a bundle can hold (missing ones are skipped on delete). */
export function bundleFileKeys(bundleKey: string): string[] {
  const names = ['manifest.json', 'state.ydoc', 'export.md', 'export.txt', 'export.html', 'static.html', 'threads.json', 'files.json'];
  return names.map((name) => bundleKey + name);
}

/** Deletes what `renderBundle` stored (a checkpoint that failed to commit). */
export async function deleteBundle(storage: Storage, bundleKey: string): Promise<void> {
  for (const key of bundleFileKeys(bundleKey)) await storage.delete(key).catch(() => undefined);
}

async function openThreads(documentId: string): Promise<BundleThread[]> {
  const rows = await db
    .select({
      threadId: threads.id,
      anchor: threads.anchor,
      createdAt: threads.createdAt,
      commentCount: sql<number>`count(${comments.id}) filter (where ${comments.deletedAt} is null)::int`,
    })
    .from(threads)
    .leftJoin(comments, eq(comments.threadId, threads.id))
    .where(and(eq(threads.documentId, documentId), isNull(threads.resolvedAt)))
    .groupBy(threads.id)
    .orderBy(threads.createdAt);
  return rows.map((r) => ({
    threadId: r.threadId,
    quote: quoteOf(r.anchor),
    commentCount: r.commentCount,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The text a thread is about. */
export function quoteOf(anchor: { type: string; selectorText?: string; innerText?: string }): string {
  return anchor.type === 'text-range' ? (anchor.selectorText ?? '') : (anchor.innerText ?? '');
}

/** The document's own stored files, for rendering them into a page. */
export function storedFiles(storage: Storage, documentId: string): FileResolver {
  return async (id) => {
    const [file] = await db
      .select({ storageKey: docFiles.storageKey, contentType: docFiles.contentType })
      .from(docFiles)
      .where(and(eq(docFiles.documentId, documentId), eq(docFiles.id, id)));
    if (!file) return null;
    return { contentType: file.contentType, bytes: new Uint8Array(await new Response(await storage.get(file.storageKey)).arrayBuffer()) };
  };
}

const BLOB = /primer-blob:\/\/([0-9a-f-]{36})/g;

/**
 * Ids of this document's files (`primer-blob://<id>`) referenced in its tabs.
 * Block props are editor-writable, so an id that belongs to another document
 * is left out.
 */
async function referencedFiles(doc: Y.Doc, documentId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const tab of tabsOf(doc)) {
    for (const match of JSON.stringify(readBlocks(doc, tab.id)).matchAll(BLOB)) ids.add(match[1]!);
  }
  if (ids.size === 0) return [];
  const own = await db
    .select({ id: docFiles.id })
    .from(docFiles)
    .where(and(eq(docFiles.documentId, documentId), inArray(docFiles.id, [...ids])));
  return own.map((f) => f.id);
}
