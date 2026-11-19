import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import type { PartialBlock } from '@blocknote/core';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { serverEditor } from './editor.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { applyPlan } from './pipeline.ts';

/** A live Markdown document row owned by `uploaderId`. */
export async function createLiveDoc(
  opts: { uploaderId?: string; visibility?: 'org' | 'private' } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(documents).values({
    id,
    title: 'Live doc',
    uploaderId: opts.uploaderId ?? 'mock-user-1',
    visibility: opts.visibility ?? 'private',
    format: 'markdown',
  });
  return id;
}

/** Replaces the main tab's content with `blocks`, as the system. */
export async function seedBlocks(documentId: string, blocks: PartialBlock[]): Promise<void> {
  const content = serverEditor()._blocksToProsemirrorNode(blocks as never);
  await applyPlan(documentId, SYSTEM_ORIGIN, {
    onConflict: 'refuse',
    edits: [
      {
        target: { tabId: 'main', blockId: '' },
        inverse: false,
        build: (tr) => {
          tr.replaceWith(0, tr.doc.content.size, content.content);
        },
      },
    ],
  });
}

/** Runs `fn` against the in-memory Y.Doc the hub and the pipeline share. */
export async function withLiveDoc<T>(documentId: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    return await fn(connection.document!);
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

export function paragraph(id: string, text: string): PartialBlock {
  return { id, type: 'paragraph', content: text };
}
