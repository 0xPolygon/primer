// Primer companion script v1.
// Loaded by the upload pipeline into every artifact iframe.
// Lives in the iframe (sandbox: allow-scripts allow-forms, opaque-origin "null").
// Talks to the parent ONLY via a MessageChannel port transferred at init.
(() => {
  /** @type {MessagePort | null} */
  let port = null;

  /** @type {{ id: string, data: any }[]} */
  let knownAnchors = [];

  /** @type {Set<string>} */
  const driftedIds = new Set();

  /** @type {{ level: 'info' | 'warn' | 'error', message: string }[]} */
  const logBuffer = [];
  const LOG_BUFFER_CAP = 100;

  function log(level, ...args) {
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    // Local iframe console always — useful when inspecting the iframe directly.
    // eslint-disable-next-line no-console
    console.log('[primer/companion][' + level + ']', ...args);
    if (port) {
      try {
        port.postMessage({ type: 'companion_log', level, message });
      } catch (e) {
        // port closed mid-send; nothing to do
      }
    } else {
      logBuffer.push({ level, message });
      if (logBuffer.length > LOG_BUFFER_CAP) logBuffer.shift();
    }
  }
  log.info = (...args) => log('info', ...args);
  log.warn = (...args) => log('warn', ...args);
  log.error = (...args) => log('error', ...args);

  function safeStringify(v) {
    if (v === undefined) return 'undefined';
    try {
      const s = JSON.stringify(v);
      return s ?? String(v);
    } catch {
      return String(v);
    }
  }

  function flushLogBuffer() {
    if (!port) return;
    while (logBuffer.length > 0) {
      const entry = logBuffer.shift();
      try {
        port.postMessage({
          type: 'companion_log',
          level: entry.level,
          message: entry.message,
        });
      } catch (e) {
        break; // port died mid-flush
      }
    }
  }

  // ── 1. Init handshake ────────────────────────────────────────────
  // Symmetric handshake: the companion announces readiness immediately and
  // retries every 500ms until the parent posts `init` (with a transferable
  // MessagePort). This decouples init from the parent's iframe load-event
  // attachment timing — historically a race on cached page loads.
  // If retries exhaust without receiving init, post a companion_panic so
  // the parent at least surfaces a visible failure mode.

  const READY_RETRY_MS = 500;
  const READY_MAX_TRIES = 10;
  let readyTimer = null;
  let readyTries = 0;

  function postReady() {
    try {
      window.parent.postMessage({ type: 'companion_ready' }, '*');
    } catch (e) {
      // window.parent inaccessible (top-level page); nothing to do.
    }
  }

  function postPanic(reason) {
    try {
      window.parent.postMessage({ type: 'companion_panic', reason }, '*');
    } catch (e) {
      // best-effort
    }
  }

  function startReadyRetry() {
    postReady();
    readyTimer = setInterval(() => {
      if (port !== null) {
        clearInterval(readyTimer);
        readyTimer = null;
        return;
      }
      readyTries += 1;
      if (readyTries >= READY_MAX_TRIES) {
        clearInterval(readyTimer);
        readyTimer = null;
        postPanic('init handshake exhausted retries');
        log.error('init handshake exhausted retries');
        return;
      }
      postReady();
    }, READY_RETRY_MS);
  }

  /** @type {((event: MessageEvent) => void) | null} */
  let onWindowMessage = (event) => {
    if (!event.ports || event.ports.length === 0) return;
    const incoming = event.data;
    if (!incoming || incoming.type !== 'init') return;

    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();

    if (readyTimer) {
      clearInterval(readyTimer);
      readyTimer = null;
    }

    if (Array.isArray(incoming.anchors)) {
      knownAnchors = incoming.anchors;
      log.info('init received, anchors:', knownAnchors.length);
      renderTextRangeMarkers();
      renderElementBadges();
    }

    flushLogBuffer();

    if (onWindowMessage) {
      window.removeEventListener('message', onWindowMessage);
      onWindowMessage = null;
    }
  };

  window.addEventListener('message', onWindowMessage);
  startReadyRetry();

  // ── 2. Port message dispatcher ───────────────────────────────────
  function onPortMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    log.info('inbound', msg.type);

    switch (msg.type) {
      case 'update_anchors':
        if (Array.isArray(msg.anchors)) {
          knownAnchors = msg.anchors;
          driftedIds.clear();
          renderTextRangeMarkers();
          renderElementBadges();
        }
        break;
      case 'enter_pick_mode':
        enterPickMode();
        break;
      case 'exit_pick_mode':
        exitPickMode('parent');
        break;
      case 'set_focused_anchor':
        setFocusedAnchor(typeof msg.anchorId === 'string' ? msg.anchorId : null);
        break;
      case 'request_anchor_positions':
        if (port) {
          port.postMessage({
            type: 'anchor_positions',
            positions: computeAnchorPositions(),
          });
        }
        break;
      default:
        log.warn('unknown inbound', msg.type);
    }
  }

  // ── 3. Capability wiring (filled in by later tasks) ──────────────
  // Selection capture: Task 7
  // Marker rendering: Tasks 8, 9
  // Pick mode: Task 10
  // Position resolution + ResizeObserver: Task 11

  // ── External-nav forwarding ──────────────────────────────────────
  // Sandbox without allow-popups silently kills window.open / target=_blank.
  // We intercept the two common paths and forward to the parent for opening.

  function postOpenExternal(url) {
    if (!port) {
      log.warn('open_external attempted before init; dropping', url);
      return;
    }
    port.postMessage({ type: 'open_external', url });
  }

  // (a) anchor clicks with target="_blank" or "_top"
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const a = target.closest('a[target="_blank"], a[target="_top"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      // Resolve relative hrefs against the iframe document base.
      const resolved = new URL(href, document.baseURI).href;
      postOpenExternal(resolved);
    },
    true /* capture phase, so artifact handlers can't preempt us */
  );

  // (b) window.open() override.
  // The companion is `defer` + end-of-body, so this runs after all inline
  // artifact scripts. Artifacts that cached `window.open` early will miss
  // the override — that's a documented limitation (failure mode: link does
  // nothing, since the sandbox blocked it anyway).
  const _nativeOpen = window.open;
  window.open = function patchedOpen(url) {
    if (typeof url === 'string') postOpenExternal(url);
    return null; // mimic the sandbox-blocked behavior
  };
  // Silence "unused variable" without exposing the native to artifacts.
  void _nativeOpen;

  // ── Pure helpers used across capture / rendering ─────────────────

  const BLOCK_TAGS = new Set([
    'BODY','ARTICLE','SECTION','DIV','P',
    'H1','H2','H3','H4','H5','H6',
    'LI','TD','TH','BLOCKQUOTE','PRE','DETAILS',
  ]);

  function normalize(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  function serializeRect(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function nearestBlockAncestor(node) {
    let el = node instanceof Element ? node : node.parentElement;
    while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el || document.body;
  }

  function cssPath(el) {
    if (el === document.body) return 'body';
    /** @type {string[]} */
    const parts = [];
    /** @type {Element | null} */
    let cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === cur.tagName
      );
      const nth = siblings.indexOf(cur) + 1;
      parts.push(siblings.length > 1 ? `${tag}:nth-of-type(${nth})` : tag);
      cur = parent;
    }
    parts.push('body');
    return parts.reverse().join(' > ');
  }

  /**
   * Walk text inside `container`, collect the normalized text up to and after the
   * selected range, return the trailing `n` chars before the range start and the
   * leading `n` chars after the range end.
   */
  function collectContext(container, range, n) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let beforeRaw = '';
    let afterRaw = '';
    let node = walker.nextNode();
    while (node) {
      if (node === range.startContainer) {
        beforeRaw += node.nodeValue.slice(0, range.startOffset);
        break;
      }
      // If the node is positioned before the start container in document order,
      // accumulate its full text into `beforeRaw`.
      const cmp = range.startContainer.compareDocumentPosition(node);
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) {
        beforeRaw += node.nodeValue;
      }
      node = walker.nextNode();
    }
    // Second pass for the trailing context.
    const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    node = walker2.nextNode();
    let foundEnd = false;
    while (node) {
      if (node === range.endContainer) {
        afterRaw += node.nodeValue.slice(range.endOffset);
        foundEnd = true;
      } else if (foundEnd) {
        afterRaw += node.nodeValue;
      }
      node = walker2.nextNode();
    }
    const beforeN = normalize(beforeRaw).slice(-n);
    const afterN = normalize(afterRaw).slice(0, n);
    return { prefix: beforeN, suffix: afterN };
  }

  // ── Selection capture ────────────────────────────────────────────

  let lastEmittedFingerprint = '';
  let lastEmittedAt = 0;

  function onPossibleSelection() {
    if (!port) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    const selectorText = sel.toString();
    if (selectorText.trim().length === 0) return;

    const container = nearestBlockAncestor(range.startContainer);
    const { prefix, suffix } = collectContext(container, range, 32);
    const containerPath = cssPath(container);

    const fingerprint = `${containerPath}|${prefix}|${selectorText}|${suffix}`;
    if (fingerprint === lastEmittedFingerprint && Date.now() - lastEmittedAt < 200) {
      return;
    }
    lastEmittedFingerprint = fingerprint;
    lastEmittedAt = Date.now();

    const clientRects = Array.from(range.getClientRects()).map(serializeRect);

    port.postMessage({
      type: 'selection_captured',
      anchor: {
        type: 'text-range',
        selectorText,
        prefix,
        suffix,
        containerPath,
      },
      clientRects,
    });
  }

  document.addEventListener('mouseup', () => requestAnimationFrame(onPossibleSelection));
  document.addEventListener('keyup', () => requestAnimationFrame(onPossibleSelection));

  // ── Marker rendering: text-range ─────────────────────────────────
  // Uses CSS Custom Highlight API to paint highlights without mutating
  // the artifact DOM. Falls back to "no marker, mark drifted" when a
  // text-range can't be resolved.

  const STYLE_TAG_ID = '__primer_companion_style__';

  function ensureStyleTag() {
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_TAG_ID;
    style.setAttribute('data-primer', '1');
    style.textContent = `
      /* Default (unfocused) — subtle yellow wash. Forces dark text so it
         stays readable on dark-mode artifacts. */
      ::highlight(primer-mark) {
        background: rgba(253, 224, 71, 0.45);
        color: #111827;
      }
      /* Focused (sticky) — dramatically more saturated + thick amber
         underline. Designed to be unambiguous against any artifact
         background, light or dark. */
      ::highlight(primer-mark-focused) {
        background: rgba(217, 119, 6, 0.95);
        color: #ffffff;
        text-decoration: underline;
        text-decoration-color: rgba(120, 53, 15, 1);
        text-decoration-thickness: 3px;
        text-underline-offset: 3px;
      }
      .__primer_badge__ {
        position: absolute;
        background: rgba(254, 240, 138, 0.95);
        border: 1px solid rgba(202, 138, 4, 0.6);
        border-radius: 9999px;
        padding: 0 6px;
        font: 11px/16px system-ui;
        pointer-events: auto;
        cursor: pointer;
      }
      .__primer_badge__.focused {
        background: rgba(252, 211, 77, 1);
        outline: 2px solid rgba(202, 138, 4, 0.8);
      }
      .__primer_pick_outline__ {
        position: absolute;
        outline: 2px solid rgba(59, 130, 246, 0.8);
        outline-offset: -2px;
        pointer-events: none;
      }
    `;
    document.head.insertBefore(style, document.head.firstChild);
  }

  /** Two Highlight objects we move ranges between. */
  let highlightDefault = null;
  let highlightFocused = null;
  function ensureHighlights() {
    if (!('Highlight' in window) || !window.CSS || !CSS.highlights) {
      log.warn('CSS Custom Highlight API not available; text-range markers disabled');
      return false;
    }
    if (!highlightDefault) {
      highlightDefault = new Highlight();
      CSS.highlights.set('primer-mark', highlightDefault);
    }
    if (!highlightFocused) {
      highlightFocused = new Highlight();
      CSS.highlights.set('primer-mark-focused', highlightFocused);
    }
    return true;
  }

  /** anchorId → Range (for live anchors), so highlight_anchor can find the range. */
  const rangeByAnchorId = new Map();

  function resolveTextRange(anchor) {
    /** @type {Element | null} */
    let container;
    try {
      container = document.querySelector(anchor.containerPath);
    } catch {
      return null;
    }
    if (!container) return null;

    // Build a flat text buffer + segments mapping back to (textNode, offset).
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    /** @type {{ node: Text, start: number }[]} */
    const segs = [];
    let raw = '';
    let n = walker.nextNode();
    while (n) {
      segs.push({ node: /** @type {Text} */ (n), start: raw.length });
      raw += n.nodeValue;
      n = walker.nextNode();
    }

    const normalizedRaw = normalize(raw);
    const needle = normalize(anchor.prefix + anchor.selectorText + anchor.suffix);
    const hit = normalizedRaw.indexOf(needle);
    if (hit === -1) return null;

    // Map the normalized hit back to raw offsets.
    const rawStart = mapNormalizedToRaw(
      raw,
      hit + normalize(anchor.prefix).length
    );
    const rawEnd = mapNormalizedToRaw(
      raw,
      hit + normalize(anchor.prefix).length + normalize(anchor.selectorText).length
    );
    if (rawStart < 0 || rawEnd < 0) return null;

    const start = locateInSegments(segs, rawStart);
    const end = locateInSegments(segs, rawEnd);
    if (!start || !end) return null;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function mapNormalizedToRaw(raw, normalizedOffset) {
    // Walk `raw`, counting normalized characters (single-space-collapsed,
    // leading whitespace dropped) until we reach normalizedOffset.
    let i = 0;
    // Skip leading whitespace that normalize() strips, so offset 0 lands on
    // the first visible character.
    while (i < raw.length && /\s/.test(raw[i])) i++;
    let nIdx = 0;
    let inWS = false;
    while (i < raw.length && nIdx < normalizedOffset) {
      const ch = raw[i];
      const isWS = /\s/.test(ch);
      if (isWS) {
        if (!inWS) nIdx++; // a run of whitespace contributes one space
        inWS = true;
      } else {
        inWS = false;
        nIdx++;
      }
      i++;
    }
    return nIdx === normalizedOffset ? i : -1;
  }

  function locateInSegments(segs, rawOffset) {
    for (const seg of segs) {
      const end = seg.start + seg.node.nodeValue.length;
      if (rawOffset >= seg.start && rawOffset <= end) {
        return { node: seg.node, offset: rawOffset - seg.start };
      }
    }
    return null;
  }

  // Sticky-focus state. Persists across `update_anchors` until the parent
  // sends a new `set_focused_anchor`. null = no focus.
  let focusedAnchorId = null;

  function renderTextRangeMarkers() {
    ensureStyleTag();
    if (!ensureHighlights()) return;

    highlightDefault.clear();
    highlightFocused.clear();
    rangeByAnchorId.clear();
    driftedIds.clear();

    for (const a of knownAnchors) {
      if (a.data.type !== 'text-range') continue;
      const range = resolveTextRange(a.data);
      if (!range) {
        driftedIds.add(a.id);
        continue;
      }
      rangeByAnchorId.set(a.id, range);
      // If this anchor is the currently-focused one, paint it focused;
      // otherwise paint the default highlight.
      if (a.id === focusedAnchorId) {
        highlightFocused.add(range);
      } else {
        highlightDefault.add(range);
      }
    }
  }

  /** Switch the focused anchor. Pass null to clear focus.
   *  Scrolls the iframe to the newly-focused anchor on transition. */
  function setFocusedAnchor(nextId) {
    const prevId = focusedAnchorId;
    if (prevId === nextId) return;
    focusedAnchorId = nextId;

    // Repaint text-range focus.
    if (prevId !== null) {
      const prevRange = rangeByAnchorId.get(prevId);
      if (prevRange && highlightFocused && highlightDefault) {
        try {
          highlightFocused.delete(prevRange);
          highlightDefault.add(prevRange);
        } catch {}
      }
    }
    if (nextId !== null) {
      const nextRange = rangeByAnchorId.get(nextId);
      if (nextRange && highlightFocused && highlightDefault) {
        try {
          highlightDefault.delete(nextRange);
          highlightFocused.add(nextRange);
        } catch {}
        try {
          const start = nextRange.startContainer;
          const parentEl = start instanceof Element ? start : start.parentElement;
          parentEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}
      }
    }

    // Repaint element-path focus (badge styling).
    if (prevId !== null) {
      const prevEntry = elementByAnchorId.get(prevId);
      prevEntry?.badge.classList.remove('focused');
    }
    if (nextId !== null) {
      const nextEntry = elementByAnchorId.get(nextId);
      if (nextEntry) {
        nextEntry.badge.classList.add('focused');
        try {
          nextEntry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}
      }
    }
  }

  // ── Click-to-focus ───────────────────────────────────────────────
  // Clicking on a highlighted span (text-range) or a tracked element
  // (element-path) tells the parent to focus the matching thread.
  // No preventDefault — the artifact's own click handlers still run.

  function findAnchorAtClick(event) {
    // If the user just selected text by dragging, treat as selection capture,
    // not focus. (selection_captured fires on the same mouseup.)
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return null;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return null;

    // Pinned 💬 badge: matches its own data-anchor-id directly.
    const badge = target.closest('.__primer_badge__');
    if (badge instanceof HTMLElement && badge.dataset.anchorId) {
      return badge.dataset.anchorId;
    }

    // Element-path: check whether the click target is inside any tracked element.
    // Iterate the map; first match wins.
    for (const [anchorId, entry] of elementByAnchorId) {
      if (entry.el.contains(target)) return anchorId;
    }

    // Text-range: check whether the click point falls inside any range's rects.
    const x = event.clientX;
    const y = event.clientY;
    for (const [anchorId, range] of rangeByAnchorId) {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return anchorId;
        }
      }
    }
    return null;
  }

  document.addEventListener('click', (event) => {
    // Pick mode owns clicks while active.
    if (pickActive) return;
    if (!port) return;
    const anchorId = findAnchorAtClick(event);
    if (!anchorId) return;
    port.postMessage({ type: 'anchor_clicked', anchorId });
  });

  // ── Overlay layer + element-pick badges ──────────────────────────

  const OVERLAY_ID = '__primer_overlay__';

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.body.appendChild(overlay);
    return overlay;
  }

  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** anchorId → { el, badge } for currently-rendered element-path anchors. */
  const elementByAnchorId = new Map();

  async function renderElementBadges() {
    const overlay = ensureOverlay();
    ensureStyleTag();

    // Clear stale.
    for (const { badge } of elementByAnchorId.values()) {
      badge.remove();
    }
    elementByAnchorId.clear();

    for (const a of knownAnchors) {
      if (a.data.type !== 'element-path') continue;
      let el = null;
      try {
        el = document.querySelector(a.data.path);
      } catch {
        el = null;
      }
      if (!el) {
        driftedIds.add(a.id);
        continue;
      }
      const expected = a.data.innerHash;
      const actual = (await sha256Hex(normalize(el.textContent ?? ''))).slice(0, 16);
      if (actual !== expected) {
        driftedIds.add(a.id);
        continue;
      }
      const badge = document.createElement('div');
      badge.className = '__primer_badge__';
      // Re-apply focus state across re-renders (update_anchors clears + rebuilds).
      if (a.id === focusedAnchorId) badge.classList.add('focused');
      badge.dataset.anchorId = a.id;
      badge.textContent = '💬';
      overlay.appendChild(badge);
      elementByAnchorId.set(a.id, { el, badge });
    }

    repositionElementBadges();
  }

  function repositionElementBadges() {
    for (const { el, badge } of elementByAnchorId.values()) {
      const rect = el.getBoundingClientRect();
      badge.style.left = `${rect.right + 4}px`;
      badge.style.top = `${rect.top}px`;
    }
  }

  // ── Pick mode ────────────────────────────────────────────────────

  let pickActive = false;
  let pickOutline = null;
  let prevBodyCursor = '';

  function enterPickMode() {
    if (pickActive) return;
    pickActive = true;
    prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    pickOutline = document.createElement('div');
    pickOutline.className = '__primer_pick_outline__';
    ensureOverlay().appendChild(pickOutline);

    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
  }

  function exitPickMode(reason /* 'click' | 'esc' | 'parent' */) {
    if (!pickActive) return;
    pickActive = false;
    document.body.style.cursor = prevBodyCursor;
    pickOutline?.remove();
    pickOutline = null;

    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);

    // 'click' exits are implicit in element_picked; 'parent' was parent-initiated.
    // Only 'esc' needs an explicit pick_mode_exited so the parent UI can revert.
    if (reason === 'esc' && port) {
      port.postMessage({ type: 'pick_mode_exited' });
    }
  }

  let pickMoveQueued = false;
  function onPickMove(e) {
    if (pickMoveQueued) return;
    pickMoveQueued = true;
    requestAnimationFrame(() => {
      pickMoveQueued = false;
      if (!pickActive || !pickOutline) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const r = target.getBoundingClientRect();
      pickOutline.style.left = `${r.left}px`;
      pickOutline.style.top = `${r.top}px`;
      pickOutline.style.width = `${r.width}px`;
      pickOutline.style.height = `${r.height}px`;
    });
  }

  async function onPickClick(e) {
    if (!pickActive) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Don't let the artifact's own click handlers fire.
    e.preventDefault();
    e.stopImmediatePropagation();

    const path = cssPath(target);
    const rawText = normalize(target.textContent ?? '');
    const innerHash = (await sha256Hex(rawText)).slice(0, 16);
    // Trim + cap the human-readable label so the JSON payload stays small
    // and the sidebar preview is uncluttered.
    const innerText = rawText.length > 160 ? `${rawText.slice(0, 160)}…` : rawText;
    const clientRect = serializeRect(target.getBoundingClientRect());

    exitPickMode('click');

    if (port) {
      port.postMessage({
        type: 'element_picked',
        anchor: { type: 'element-path', path, innerHash, innerText },
        clientRect,
      });
    }
  }

  function onPickKey(e) {
    if (!pickActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      exitPickMode('esc');
    }
  }

  // ── Anchor positions + resize ────────────────────────────────────

  function computeAnchorPositions() {
    /** @type {{ anchorId: string, rects: any[], drifted?: boolean }[]} */
    const out = [];
    for (const a of knownAnchors) {
      if (driftedIds.has(a.id)) {
        out.push({ anchorId: a.id, rects: [], drifted: true });
        continue;
      }
      if (a.data.type === 'text-range') {
        const range = rangeByAnchorId.get(a.id);
        if (!range) {
          out.push({ anchorId: a.id, rects: [], drifted: true });
          continue;
        }
        out.push({
          anchorId: a.id,
          rects: Array.from(range.getClientRects()).map(serializeRect),
        });
      } else {
        const entry = elementByAnchorId.get(a.id);
        if (!entry) {
          out.push({ anchorId: a.id, rects: [], drifted: true });
          continue;
        }
        out.push({
          anchorId: a.id,
          rects: [serializeRect(entry.el.getBoundingClientRect())],
        });
      }
    }
    return out;
  }

  // ── Resize observer ──────────────────────────────────────────────

  const ro = new ResizeObserver(() => {
    repositionElementBadges();
    if (port) {
      const h = document.documentElement.scrollHeight || document.body.scrollHeight;
      port.postMessage({ type: 'resize', height: h });
    }
  });
  ro.observe(document.body);

  // ── Scroll tracking for element-pick badges ─────────────────────
  // Scroll doesn't bubble; capture-phase on window picks up scrolls from
  // any scrollable ancestor. CSS Custom Highlights follow scroll on their
  // own (browser-rendered), so only the overlay badges need this.
  window.addEventListener(
    'scroll',
    () => {
      repositionElementBadges();
    },
    { passive: true, capture: true }
  );
})();
