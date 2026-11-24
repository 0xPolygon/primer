import * as Y from 'yjs';
import { Hocuspocus, type Connection } from '@hocuspocus/server';
import { attachPersistence, loadYDoc, persistedUpTo } from './persist.ts';
import { liveAccess, type LiveContext } from './auth.ts';
import { logger } from '../logger.ts';
import { sanitizeClientAwareness } from './awareness.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { cancelOrphanSync, scheduleOrphanSync } from './orphans.ts';

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

/** The largest awareness state (cursor, name, colour) a peer may publish. */
export const MAX_AWARENESS_BYTES = 4096;

/** The awareness client ids each connection has published under. */
const presenceOwned = new WeakMap<Connection, Set<number>>();

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
    // Awareness is client-writable; only the server sets agent states.
    async beforeHandleAwareness({ context, documentName, states, removedClients }) {
      const user = (context as LiveContext | undefined)?.user;
      const documentId = documentIdOf(documentName);
      if (user && documentId) sanitizeClientAwareness(documentId, user, states, removedClients);
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
      const recheckThreads = () => scheduleOrphanSync(documentId, document);
      document.on('update', recheckThreads);
      // Detach only once the document is really gone: Hocuspocus keeps it
      // after beforeUnloadDocument when someone connected meanwhile.
      document.on('destroy', () => {
        document.off('update', recheckThreads);
        cancelOrphanSync(documentId);
        void detach();
      });
    },
    // A peer may publish presence only under client ids it owns: the first
    // connection to publish an id owns it until that connection closes. States
    // over the size limit are dropped from the update.
    async beforeHandleAwareness({ connection, document, states, removedClients }) {
      if (!connection) return;
      const own = presenceOwned.get(connection) ?? presenceOwned.set(connection, new Set()).get(connection)!;
      // Another person's connection holds it; the same person's (a reconnect
      // that beat the old socket's close) doesn't.
      const userOf = (c: Connection) => (c.context as LiveContext | undefined)?.user?.id;
      const heldByOthers = (clientId: number) =>
        document.getConnections().some(
          (other) => other !== connection && userOf(other) !== userOf(connection) && presenceOwned.get(other)?.has(clientId),
        );
      for (const [clientId, state] of states) {
        if (heldByOthers(clientId) || Buffer.byteLength(JSON.stringify(state)) > MAX_AWARENESS_BYTES) states.delete(clientId);
        else own.add(clientId);
      }
      for (const clientId of removedClients) if (!own.has(clientId)) removedClients.delete(clientId);
    },
    async beforeUnloadDocument({ document }) {
      await persistedUpTo(document).catch(() => undefined);
    },
  });
  return instance;
}

/**
 * Runs `fn` against a live document's in-memory Y.Doc (loading it if no one
 * has it open), for reads such as exports. Writes go through `applyPlan`.
 */
export async function withLiveDocument<T>(documentId: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    return await fn(connection.document!);
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}
