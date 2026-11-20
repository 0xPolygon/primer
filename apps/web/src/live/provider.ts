import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

/** Close codes the server ends a live connection with (apps/api/src/live/hub.ts). */
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_SAVE_FAILED = 4500;

export type LiveProvider = { provider: HocuspocusProvider; doc: Y.Doc; destroy(): void };

/**
 * The live connection to one document: `/collab` on the app's own origin
 * (the session cookie authenticates it), document `doc:<id>`.
 */
export function createLiveProvider(documentId: string): LiveProvider {
  const doc = new Y.Doc();
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const provider = new HocuspocusProvider({
    url: `${scheme}//${window.location.host}/collab`,
    name: `doc:${documentId}`,
    document: doc,
  });
  return {
    provider,
    doc,
    destroy() {
      provider.destroy();
      doc.destroy();
    },
  };
}
