import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { attachPersistence, loadYDoc, persistedUpTo } from './persist.ts';
import { liveAccess, type LiveContext } from './auth.ts';
import { logger } from '../logger.ts';

const NAME = /^doc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The Hocuspocus document name of a live document. */
export function liveDocName(documentId: string): string {
  return `doc:${documentId}`;
}

/** The document id in a Hocuspocus document name, or null. */
export function documentIdOf(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null;
}

const failureHandlers = new Set<(documentId: string, doc: Y.Doc) => void>();

/** Runs when a document's persistence fails (the hub closes its sockets). */
export function onPersistenceFailure(handler: (documentId: string, doc: Y.Doc) => void): () => void {
  failureHandlers.add(handler);
  return () => failureHandlers.delete(handler);
}

let instance: Hocuspocus | null = null;

/**
 * The process's one Hocuspocus: one in-memory Y.Doc per open live document,
 * shared by WebSocket peers (live/hub.ts) and server writes (live/pipeline.ts)
 * so both see the same state. Peers are authorised per document; loading
 * applies the stored state and then attaches persistence; unloading waits for
 * queued inserts.
 */
export function liveInstance(): Hocuspocus {
  instance ??= new Hocuspocus({
    quiet: true,
    // WebSocket peers only (live/hub.ts resolved `auth` at the upgrade); server
    // writes open direct connections, which skip this hook.
    async onAuthenticate({ context, documentName, connectionConfig }) {
      const { auth: opened, reauth } = context as LiveContext;
      const documentId = documentIdOf(documentName);
      if (!opened || !documentId) throw new Error('forbidden');
      // The upgrade's auth may be stale: a token revoked since then must not join.
      const auth = reauth ? await reauth() : opened;
      if (!auth) throw new Error('forbidden');
      const access = await liveAccess(auth, documentId);
      if (access === 'none') throw new Error('forbidden');
      connectionConfig.readOnly = access !== 'write';
      return { user: auth.user, documentId } satisfies LiveContext;
    },
    async onLoadDocument({ document, documentName }) {
      const documentId = documentIdOf(documentName);
      if (!documentId) throw new Error(`not a live document name: ${documentName}`);
      const { doc, docVersion } = await loadYDoc(documentId);
      Y.applyUpdate(document, Y.encodeStateAsUpdate(doc));
      doc.destroy();
      const detach = attachPersistence(document, documentId, {
        docVersion,
        onFailure: (err) => {
          logger.error({ documentId, error: err.message }, 'live document: saving an update failed');
          for (const handler of failureHandlers) handler(documentId, document);
        },
      });
      // Detach only once the document is really gone: Hocuspocus keeps it
      // after beforeUnloadDocument when someone connected meanwhile.
      document.on('destroy', () => void detach());
    },
    async beforeUnloadDocument({ document }) {
      await persistedUpTo(document).catch(() => undefined);
    },
  });
  return instance;
}
