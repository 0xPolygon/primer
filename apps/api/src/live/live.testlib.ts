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

/** A live hub on an in-test HTTP server, authenticated by the test persona
 *  header (`x-mock-user-id`) with the app origin. */
export async function startTestHub() {
  const { createServer } = await import('node:http');
  const { HocuspocusProvider } = await import('@hocuspocus/provider');
  const { mockMultiResolver } = await import('../auth/resolver.ts');
  const { createHub } = await import('./hub.ts');
  const appOrigin = 'http://app.test';
  const hub = createHub({ resolver: mockMultiResolver, appOrigin });
  const server = createServer();
  server.on('upgrade', hub.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const providers: InstanceType<typeof HocuspocusProvider>[] = [];

  /** Connects as `userId`; resolves once synced. */
  async function connect(documentId: string, userId: string) {
    const headers = { 'x-mock-user-id': userId, origin: appOrigin };
    class HeaderWebSocket extends WebSocket {
      constructor(target: string | URL) {
        super(target, { headers } as never);
      }
    }
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: liveDocName(documentId),
      document: doc,
      WebSocketPolyfill: HeaderWebSocket,
      maxAttempts: 1,
    } as ConstructorParameters<typeof HocuspocusProvider>[0]);
    providers.push(provider);
    await new Promise<void>((resolve, reject) => {
      provider.on('synced', () => resolve());
      provider.on('authenticationFailed', () => reject(new Error('authentication failed')));
    });
    return { provider, doc };
  }

  async function close() {
    for (const provider of providers.splice(0)) provider.destroy();
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { connect, close };
}

/** Polls `check` until it holds (or throws after `ms`). */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
