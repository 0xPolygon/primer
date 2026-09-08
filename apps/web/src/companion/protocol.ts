/**
 * The parent-side half of Primer's companion postMessage protocol: message
 * shapes, the window-level handshake envelope, and the runtime parsers that
 * validate untrusted messages arriving from the sandboxed artifact iframe.
 * The iframe half — the standalone plain-JS script that posts these same
 * shapes — is `apps/api/src/companion/v1.js`. Kept in sync by hand; there
 * is no shared module between the two halves, since one is TypeScript
 * bundled into this app and the other is plain JS loaded directly into an
 * opaque-origin sandboxed iframe.
 *
 * Moved from packages/shared/src/companion-protocol.ts. The anchor shapes
 * (`AnchorData`, `TextRangeAnchor`, `ElementPathAnchor`) and their guards
 * moved to `@polygonlabs/primer-api-types` instead — they're part of the
 * wire contract (stored in `threads.anchor`), not the envelope.
 */
import type {
  AnchorData,
  ElementPathAnchor,
  EventInput,
  EventRowDTO,
  TextRangeAnchor,
} from '@polygonlabs/primer-api-types';
import {
  EVENT_NAMESPACE_RE,
  EVENT_TYPE_RE,
  MAX_EVENT_NAMESPACE_LENGTH,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENTS_PER_BATCH,
  isElementPathAnchor,
  isEventAudience,
  isTextRangeAnchor,
} from '@polygonlabs/primer-api-types';

export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchor {
  id: string;
  data: AnchorData;
}

// Parent → Iframe
export type Theme = 'light' | 'dark';

export interface MsgInit {
  type: 'init';
  anchors: Anchor[];
  /** Parent's effective theme at iframe load. Companion sets
   *  document.documentElement.dataset.theme accordingly. Older companion
   *  snapshots ignore unknown init fields, so this is forward-compatible. */
  theme: Theme;
}
export interface MsgUpdateAnchors {
  type: 'update_anchors';
  anchors: Anchor[];
}
export interface MsgEnterPickMode {
  type: 'enter_pick_mode';
}
export interface MsgExitPickMode {
  type: 'exit_pick_mode';
}
/** Sticky-focus mode. Sending an anchorId focuses that anchor and keeps it
 *  highlighted until another `set_focused_anchor` arrives. Sending null clears
 *  the focus. The companion repaints focus state automatically on
 *  `update_anchors` so the focus survives anchor refreshes. */
export interface MsgSetFocusedAnchor {
  type: 'set_focused_anchor';
  anchorId: string | null;
}
export interface MsgRequestAnchorPositions {
  type: 'request_anchor_positions';
}
export interface MsgThemeChanged {
  type: 'theme_changed';
  theme: Theme;
}
/** Document-events read relay (issue #78): `artifact`-audience event rows,
 *  forwarded VERBATIM into the iframe in coalesced batches (the initial list
 *  fetch as one batch, a re-fetch as one batch, stream bursts coalesced).
 *  Grouping carries NO semantics — the artifact must derive identical state
 *  however the same rows are partitioned into dispatches (it interprets rows
 *  by id, not by arrival grouping). The companion re-dispatches these to
 *  artifact JS as CustomEvent('primer:events', { detail: { events } }). */
export interface MsgEventsRelay {
  type: 'events';
  events: EventRowDTO[];
}
/** Write acknowledgment for a prior `submit_events` — `rows` carries the
 *  created rows (server-assigned ids + stored audiences) so the artifact can
 *  reconcile an optimistic echo with server-attributed truth. Re-dispatched
 *  by the companion as CustomEvent('primer:submit-result'). */
export interface MsgSubmitResult {
  type: 'submit_result';
  ok: boolean;
  rows?: EventRowDTO[];
  error?: string;
}

export type OutboundProtocolMessage =
  | MsgInit
  | MsgUpdateAnchors
  | MsgEnterPickMode
  | MsgExitPickMode
  | MsgSetFocusedAnchor
  | MsgRequestAnchorPositions
  | MsgThemeChanged
  | MsgEventsRelay
  | MsgSubmitResult;

// Iframe → Parent
export interface MsgSelectionCaptured {
  type: 'selection_captured';
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}
export interface MsgElementPicked {
  type: 'element_picked';
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}
export interface MsgPickModeExited {
  type: 'pick_mode_exited';
}
/** Fired when a previously-captured text selection collapses or is cleared
 *  inside the iframe (e.g. the user clicked elsewhere). Lets the parent
 *  auto-dismiss a still-empty new-thread composer. */
export interface MsgSelectionCleared {
  type: 'selection_cleared';
}
export interface MsgAnchorPositions {
  type: 'anchor_positions';
  positions: { anchorId: string; rects: SerializableRect[]; drifted?: boolean }[];
}
export interface MsgResize {
  type: 'resize';
  height: number;
}
/** Fired when the artifact's content is intrinsically wider than the iframe
 *  viewport (companion only sends it on overflow, never for fitting
 *  content). The parent uses it to scale the iframe down to fit narrow
 *  screens. */
export interface MsgContentMetrics {
  type: 'content_metrics';
  contentWidth: number;
}
export interface MsgOpenExternal {
  type: 'open_external';
  url: string;
}
/** Fired when the user clicks on a highlighted anchor inside the iframe.
 *  The parent uses this to focus the matching thread + scroll the sidebar
 *  to its card. */
export interface MsgAnchorClicked {
  type: 'anchor_clicked';
  anchorId: string;
}
/** Log line streamed from companion to parent over the port so debugging
 *  doesn't require reaching into the iframe's opaque-origin console. */
export interface MsgCompanionLog {
  type: 'companion_log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Consent-gated event submission from the artifact (issue #78): the
 *  companion forwards CustomEvent('primer:submit-events') payloads ONLY from
 *  within the same trusted event dispatch that carried a user gesture, and
 *  we re-validate the whole batch here — the parent is the authed principal
 *  and this message came, ultimately, from untrusted artifact code. The
 *  parent POSTs the batch to /api/documents/:id/events and answers with a
 *  `submit_result`. */
export interface MsgSubmitEvents {
  type: 'submit_events';
  events: EventInput[];
}

export type InboundProtocolMessage =
  | MsgSelectionCaptured
  | MsgSelectionCleared
  | MsgElementPicked
  | MsgPickModeExited
  | MsgAnchorPositions
  | MsgResize
  | MsgContentMetrics
  | MsgOpenExternal
  | MsgAnchorClicked
  | MsgCompanionLog
  | MsgSubmitEvents;

/** Window-level handshake messages — go via window.postMessage (not the
 *  port) because they exist for the case where the port isn't established
 *  yet, or has already given up. */
export interface MsgCompanionReady {
  type: 'companion_ready';
}
export interface MsgCompanionPanic {
  type: 'companion_panic';
  reason: string;
}
export type WindowEnvelope = MsgCompanionReady | MsgCompanionPanic;

// ───────────────────── Validation helpers ─────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRect(v: unknown): v is SerializableRect {
  return (
    isObject(v) &&
    isNumber(v.x) &&
    isNumber(v.y) &&
    isNumber(v.width) &&
    isNumber(v.height)
  );
}

export function parseInboundMessage(raw: unknown): InboundProtocolMessage | null {
  if (!isObject(raw) || !isString(raw.type)) return null;

  switch (raw.type) {
    case 'selection_captured': {
      if (!isTextRangeAnchor(raw.anchor)) return null;
      if (!Array.isArray(raw.clientRects) || !raw.clientRects.every(isRect)) return null;
      return {
        type: 'selection_captured',
        anchor: raw.anchor,
        clientRects: raw.clientRects,
      };
    }
    case 'element_picked': {
      if (!isElementPathAnchor(raw.anchor)) return null;
      if (!isRect(raw.clientRect)) return null;
      return { type: 'element_picked', anchor: raw.anchor, clientRect: raw.clientRect };
    }
    case 'pick_mode_exited':
      return { type: 'pick_mode_exited' };
    case 'selection_cleared':
      return { type: 'selection_cleared' };
    case 'anchor_positions': {
      if (!Array.isArray(raw.positions)) return null;
      const positions: MsgAnchorPositions['positions'] = [];
      for (const p of raw.positions) {
        if (!isObject(p) || !isString(p.anchorId)) return null;
        if (!Array.isArray(p.rects) || !p.rects.every(isRect)) return null;
        const entry: MsgAnchorPositions['positions'][number] = {
          anchorId: p.anchorId,
          rects: p.rects,
        };
        if (p.drifted === true) entry.drifted = true;
        positions.push(entry);
      }
      return { type: 'anchor_positions', positions };
    }
    case 'resize': {
      if (!isNumber(raw.height)) return null;
      return { type: 'resize', height: raw.height };
    }
    case 'content_metrics': {
      if (!isNumber(raw.contentWidth) || raw.contentWidth <= 0) return null;
      return { type: 'content_metrics', contentWidth: raw.contentWidth };
    }
    case 'open_external': {
      if (!isString(raw.url)) return null;
      return { type: 'open_external', url: raw.url };
    }
    case 'anchor_clicked': {
      if (!isString(raw.anchorId)) return null;
      return { type: 'anchor_clicked', anchorId: raw.anchorId };
    }
    case 'companion_log': {
      if (raw.level !== 'info' && raw.level !== 'warn' && raw.level !== 'error') return null;
      if (!isString(raw.message)) return null;
      return { type: 'companion_log', level: raw.level, message: raw.message };
    }
    case 'submit_events': {
      if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > MAX_EVENTS_PER_BATCH) {
        return null;
      }
      const events: EventInput[] = [];
      for (const e of raw.events) {
        const parsed = parseEventInput(e);
        if (!parsed) return null; // all-or-nothing, matching the API's batch semantics
        events.push(parsed);
      }
      return { type: 'submit_events', events };
    }
    default:
      return null;
  }
}

/** Validates one untrusted event of a submit batch against the api-types
 *  wire contract (the server re-validates; this keeps garbage from even
 *  reaching the network). Returns a clean copy or null. */
function parseEventInput(raw: unknown): EventInput | null {
  if (!isObject(raw)) return null;
  if (
    !isString(raw.namespace) ||
    raw.namespace.length > MAX_EVENT_NAMESPACE_LENGTH ||
    !EVENT_NAMESPACE_RE.test(raw.namespace)
  ) {
    return null;
  }
  if (!isString(raw.type) || raw.type.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE_RE.test(raw.type)) {
    return null;
  }
  if (!isEventAudience(raw.audience)) return null;
  if (!('payload' in raw)) return null;
  try {
    const json = JSON.stringify(raw.payload);
    if (typeof json !== 'string') return null;
    if (json.length > MAX_EVENT_PAYLOAD_BYTES) return null;
  } catch {
    return null;
  }
  const out: EventInput = {
    namespace: raw.namespace,
    type: raw.type,
    audience: raw.audience,
    payload: raw.payload,
  };
  if (isString(raw.versionId)) out.versionId = raw.versionId;
  return out;
}

export function parseWindowEnvelope(raw: unknown): WindowEnvelope | null {
  if (!isObject(raw) || !isString(raw.type)) return null;
  switch (raw.type) {
    case 'companion_ready':
      return { type: 'companion_ready' };
    case 'companion_panic':
      if (!isString(raw.reason)) return null;
      return { type: 'companion_panic', reason: raw.reason };
    default:
      return null;
  }
}
