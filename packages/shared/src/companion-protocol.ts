export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Text-range anchor. New captures (v1.1+) emit `start`/`end` raw
 *  character offsets into the artifact's flattened text. Legacy
 *  captures (pre-v1.1) carry `prefix`/`suffix`/`containerPath` for
 *  text-pattern resolution. The companion's resolver dispatches on
 *  which fields are present, so both shapes are valid on the wire and
 *  in storage. New code should write the position-based shape. */
export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  /** Inclusive raw cumulative character offset (position-based shape). */
  start?: number;
  /** Exclusive raw cumulative character offset (position-based shape). */
  end?: number;
  /** Legacy: text-context prefix. Present on pre-v1.1 anchors. */
  prefix?: string;
  /** Legacy: text-context suffix. Present on pre-v1.1 anchors. */
  suffix?: string;
  /** Legacy: CSS path to the nearest block ancestor. Present on
   *  pre-v1.1 anchors. */
  containerPath?: string;
}

export interface ElementPathAnchor {
  type: 'element-path';
  path: string;
  innerHash: string;
  /** Captured text content of the picked element at the moment it was picked.
   * Used for human-readable previews in the comment sidebar. Optional for
   * backward-compat with rows created before this field existed. */
  innerText?: string;
}

export type AnchorData = TextRangeAnchor | ElementPathAnchor;

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

export type OutboundProtocolMessage =
  | MsgInit
  | MsgUpdateAnchors
  | MsgEnterPickMode
  | MsgExitPickMode
  | MsgSetFocusedAnchor
  | MsgRequestAnchorPositions
  | MsgThemeChanged;

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
export interface MsgAnchorPositions {
  type: 'anchor_positions';
  positions: { anchorId: string; rects: SerializableRect[]; drifted?: boolean }[];
}
export interface MsgResize {
  type: 'resize';
  height: number;
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

export type InboundProtocolMessage =
  | MsgSelectionCaptured
  | MsgElementPicked
  | MsgPickModeExited
  | MsgAnchorPositions
  | MsgResize
  | MsgOpenExternal
  | MsgAnchorClicked
  | MsgCompanionLog;

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

export function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
  if (!isObject(v) || v.type !== 'text-range' || !isString(v.selectorText)) {
    return false;
  }
  // Position-based shape: start AND end must be finite numbers.
  const hasPosition = isNumber(v.start) && isNumber(v.end);
  // Legacy shape: prefix AND suffix AND containerPath must all be strings.
  const hasLegacy =
    isString(v.prefix) && isString(v.suffix) && isString(v.containerPath);
  return hasPosition || hasLegacy;
}

export function isElementPathAnchor(v: unknown): v is ElementPathAnchor {
  return (
    isObject(v) &&
    v.type === 'element-path' &&
    isString(v.path) &&
    isString(v.innerHash)
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
    default:
      return null;
  }
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
