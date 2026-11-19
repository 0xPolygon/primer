/**
 * What the host does for one loaded page: which bridge features it grants,
 * whether the page may reach outside Primer (`open_external`), and the
 * records capability for pages that opted in. ArtifactIframe creates one per
 * iframe load and feeds it the page's port messages and `load` events.
 *
 * The page's binding (its document and outbound policy) comes from the
 * server (`GET /api/versions/:versionId/page`), from the same stored bytes
 * the iframe is served, never from the page. Until the binding is known the
 * host sends no `init`, so the page has no port to call through.
 *
 * Navigation: a record-reading page that loads a second time navigated
 * itself (a sandboxed frame can still do that; no CSP directive stops it).
 * The host treats that as a breach: it revokes record access at once and the
 * caller reloads the page from Primer. Whatever left in the navigation's URL
 * is gone (the residual risk, see docs/prd-primer.md); nothing more follows.
 */
import { PRIMER_EVENT_NAMESPACE, type EventRowDTO, type PageInfoResponse, type PrimerDataChangedPayload } from '@polygonlabs/primer-api-types';
import type { BridgeFeature, InboundProtocolMessage, OutboundProtocolMessage } from '../companion/protocol.ts';
import type { EventSourceLike } from '../lib/eventsFeed.ts';
import { createRecordsCapability, type RecordsCapability } from './recordsCapability.ts';

/** The page's binding: a version page's info, `none` for frames that are not
 *  version pages (shares, the dev harness), `unknown` when the lookup failed. */
export type PageBinding = PageInfoResponse | 'none' | 'unknown';

const VERSION_SRC = /^\/api\/versions\/([0-9a-f-]{36})\/content$/i;

export async function loadPageBinding(src: string, fetchImpl: (url: string) => Promise<Response>): Promise<PageBinding> {
  const m = VERSION_SRC.exec(src);
  if (!m) return 'none';
  try {
    const res = await fetchImpl(`/api/versions/${m[1]}/page`);
    if (!res.ok) return 'unknown';
    return (await res.json()) as PageInfoResponse;
  } catch {
    return 'unknown';
  }
}

export interface RecordsHost {
  readonly features: BridgeFeature[];
  /** May the page open links outside Primer? Never for record-reading pages,
   *  nor when the binding is unknown. */
  readonly allowsOutbound: boolean;
  /** Starts answering on `post` (the iframe's port), after init. */
  attach(post: (msg: OutboundProtocolMessage) => void): void;
  /** Handles a records message; true when it was one (never forwarded). */
  handle(msg: InboundProtocolMessage): boolean;
  /** Call on every iframe `load`; `breach` means reload the page. */
  onLoad(): 'ok' | 'breach';
  readonly capability: RecordsCapability | null;
  dispose(): void;
}

export interface RecordsHostDeps {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  eventSourceFactory: (url: string) => EventSourceLike;
}

export function createRecordsHost(binding: PageBinding, deps: RecordsHostDeps): RecordsHost {
  const reads = typeof binding === 'object' && binding.policy === 'records';
  const capability = reads
    ? createRecordsCapability({ documentId: binding.documentId, pageTarget: binding.versionId, fetchImpl: deps.fetchImpl })
    : null;
  let post: ((msg: OutboundProtocolMessage) => void) | null = null;
  let stream: EventSourceLike | null = null;
  let loads = 0;

  const unavailable = (callId: string) =>
    post?.({
      type: 'records_result',
      callId,
      ok: false,
      refusal: {
        code: 'records_unavailable',
        message: 'This page has no record access.',
        fix: 'Add <meta name="primer-records" content="read"> to the page head and publish it again.',
      },
    });

  const stop = () => {
    stream?.close();
    stream = null;
  };

  return {
    features: reads ? ['records'] : [],
    allowsOutbound: binding === 'none' || (typeof binding === 'object' && binding.policy === 'standard'),
    capability,

    attach(p) {
      post = p;
      if (!capability || capability.revoked || stream) return;
      // Others' shared-record writes arrive as coalesced primer.data.changed
      // events (never our own viewer's). The page catches up after a gap
      // with changesSince, so starting at the stream's head is enough.
      stream = deps.eventSourceFactory(
        `/api/documents/${encodeURIComponent(capability.documentId)}/events/stream?namespace=${PRIMER_EVENT_NAMESPACE}&type=data.changed`,
      );
      stream.onmessage = (ev) => {
        if (capability.revoked) return;
        let row: EventRowDTO;
        try {
          row = JSON.parse(ev.data) as EventRowDTO;
        } catch {
          return;
        }
        const payload = row.payload as PrimerDataChangedPayload;
        if (!Array.isArray(payload?.collections) || typeof payload.to_change_id !== 'number') return;
        post?.({ type: 'records_changed', collections: payload.collections, toChangeId: payload.to_change_id });
      };
    },

    handle(msg) {
      if (msg.type === 'records_call') {
        if (!capability) unavailable(msg.callId);
        else capability.call(msg, (r) => post?.(r));
        return true;
      }
      if (msg.type === 'records_cancel') {
        capability?.cancel(msg.callId);
        return true;
      }
      return false;
    },

    onLoad() {
      loads += 1;
      if (loads === 1 || !capability) return 'ok';
      capability.revoke();
      stop();
      return 'breach';
    },

    dispose() {
      capability?.revoke();
      stop();
      post = null;
    },
  };
}
