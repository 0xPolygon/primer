import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crossws from 'crossws/adapters/node';
import type { Connection, Document, Hocuspocus, WebSocketLike } from '@hocuspocus/server';
import type { UserResolver } from '../auth/resolver.ts';
import { logger } from '../logger.ts';
import { liveAccess, resolveFromHeaders, type LiveAuth, type LiveContext } from './auth.ts';
import { documentIdOf, liveDocName, liveInstance, onPersistenceFailure } from './instance.ts';

/** The WebSocket path live documents sync on. */
export const COLLAB_PATH = '/collab';
/** Close codes the editor reacts to. */
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_SAVE_FAILED = 4500;
const RECHECK_MS = 60_000;

export type Hub = {
  hocuspocus: Hocuspocus;
  /** For the API server's `upgrade` event; anything but /collab is refused. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Re-evaluates every connection to the document now: closes those that
   *  lost read access, makes read-only those that lost write. */
  recheckDocument(documentId: string): Promise<void>;
  close(): void;
};

/**
 * Hocuspocus inside the API process, on its own HTTP server's `upgrade`
 * event, wired the way Hocuspocus's own Server is (crossws's node adapter).
 *
 * The upgrade is authenticated with Primer's own resolver chain. A
 * browser-credential connection (cookie, mock, proxy) must come from the app's
 * own Origin, so another site can't open a socket with a visitor's cookie.
 * Per document, `onAuthenticate` (live/instance.ts) admits readers read-only
 * and owners and editors read-write; bearer connections are always read-only.
 * Access is rechecked after every successful change to a document's sharing
 * (app.ts), and on a timer.
 */
export function createHub(deps: { resolver: UserResolver; appOrigin: string }): Hub {
  const hocuspocus = liveInstance();

  const ws = crossws({
    hooks: {
      upgrade: async (request) => {
        const auth = await resolveFromHeaders(deps.resolver, request.headers);
        if (!auth) throw new Response('unauthorized', { status: 401 });
        if (auth.authMethod !== 'bearer' && request.headers.get('origin') !== deps.appOrigin) {
          throw new Response('forbidden', { status: 403 });
        }
        if (auth.scopes && !auth.scopes.includes('documents:read')) {
          throw new Response('forbidden', { status: 403 });
        }
        return { context: { auth } };
      },
      open: (peer) => {
        const context: LiveContext = { auth: peer.context.auth as LiveAuth };
        const client = hocuspocus.handleConnection(peer.websocket as unknown as WebSocketLike, peer.request, context);
        (peer as unknown as { _hocuspocus: typeof client })._hocuspocus = client;
        // As Hocuspocus's Server does: pongs count as activity.
        (peer.websocket as unknown as { on?: (event: string, fn: () => void) => void }).on?.('pong', () => client.touch());
      },
      message: (peer, message) => {
        (peer as unknown as { _hocuspocus?: { handleMessage(data: Uint8Array): void } })._hocuspocus?.handleMessage(
          message.uint8Array(),
        );
      },
      close: (peer, event) => {
        (peer as unknown as { _hocuspocus?: { handleClose(e: { code?: number; reason?: string }): void } })._hocuspocus?.handleClose(
          { code: event.code, reason: event.reason },
        );
      },
      error: (peer, error) => {
        logger.warn({ peer: peer.id, error: String(error) }, 'live: websocket error');
      },
    },
  });

  // Close the socket first, so the editor sees the code (a protocol-level
  // close would reach it as 1000), then detach the connection from the
  // document at once, so no further update from it applies.
  const closeConnection = (connection: Connection, code: number, reason: string) => {
    connection.webSocket.close(code, reason);
    connection.close({ code, reason });
  };

  const recheckConnection = async (connection: Connection, documentId: string) => {
    const context = connection.context as LiveContext;
    let access: 'none' | 'read' | 'write' = 'none';
    try {
      // Re-resolve too: a signed-out session or revoked token loses access.
      const auth = await resolveFromHeaders(deps.resolver, connection.request.headers);
      if (auth && auth.user.id === context.auth?.user.id) access = await liveAccess(auth, documentId);
    } catch (err) {
      logger.warn({ documentId, error: String(err) }, 'live: access recheck failed; closing');
    }
    if (access === 'none') closeConnection(connection, CLOSE_FORBIDDEN, 'forbidden');
    else connection.readOnly = access === 'read';
  };

  const recheckDocument = async (documentId: string) => {
    const document = hocuspocus.documents.get(liveDocName(documentId));
    if (!document) return;
    await Promise.all(document.getConnections().map((connection) => recheckConnection(connection, documentId)));
  };

  const timer = setInterval(() => {
    for (const name of hocuspocus.documents.keys()) {
      const documentId = documentIdOf(name);
      if (documentId) void recheckDocument(documentId);
    }
  }, RECHECK_MS);
  timer.unref();

  // A document whose update couldn't be stored is dropped from memory so it
  // reloads from what was stored; its editors reconnect and resend.
  const stopFailures = onPersistenceFailure((_documentId, doc) => {
    const document = doc as Document;
    for (const connection of document.getConnections()) closeConnection(connection, CLOSE_SAVE_FAILED, 'save_failed');
    void hocuspocus.unloadDocument(document);
  });

  return {
    hocuspocus,
    handleUpgrade(req, socket, head) {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== COLLAB_PATH) {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(req, socket, head);
    },
    recheckDocument,
    close() {
      clearInterval(timer);
      stopFailures();
    },
  };
}
