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

  // ── Mermaid detection ────────────────────────────────────────────
  // Mirrored in mermaidScanner.test.ts; keep in sync.
  // Pinned bundle version is duplicated here as a string literal because the
  // companion is plain JS and can't import mermaidVersion.ts. See
  // apps/api/src/companion/mermaidVersion.ts.
  const MERMAID_BUNDLE_VERSION = '11.4.1';
  const MERMAID_BUNDLE_URL = '/companion/mermaid-v' + MERMAID_BUNDLE_VERSION + '.js';

  /** @returns {HTMLElement[]} block roots (always <pre>). */
  function findMermaidBlocks() {
    const matches = document.querySelectorAll(
      'pre > code.language-mermaid, pre.mermaid'
    );
    /** @type {HTMLElement[]} */
    const out = [];
    matches.forEach((el) => {
      const root = el.tagName === 'PRE' ? el : el.parentElement;
      if (!root || root.tagName !== 'PRE') return;
      if (root.querySelector(':scope > svg, :scope > div > svg')) return;
      if (out.indexOf(root) === -1) out.push(root);
    });
    return out;
  }

  /** @returns {boolean} */
  function documentHasMermaidBootstrap() {
    if (typeof window.mermaid !== 'undefined') return true;
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const src = s.getAttribute('src') || '';
      if (src && /mermaid/i.test(src)) return true;
      const text = s.textContent || '';
      if (text.indexOf('mermaid.initialize') !== -1) return true;
      if (text.indexOf('mermaid.run') !== -1) return true;
    }
    return false;
  }

  // ── Mermaid rendering ────────────────────────────────────────────
  // Loaded lazily — only when at least one matched block is present
  // AND the document doesn't already bootstrap Mermaid itself.

  /** Module-local id counter for mermaid.render. */
  let mermaidRenderCounter = 0;

  /** Cached mermaid module after first dynamic import, or null. */
  let mermaidModule = null;

  /** In-flight import promise so concurrent callers share one fetch. */
  let mermaidLoadPromise = null;

  /** @returns {'dark' | 'default'} */
  function pickMermaidTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  }

  /** Inject a classical <script src> and resolve when load fires. */
  function injectClassicalScript(url) {
    return new Promise(function (resolve, reject) {
      const el = document.createElement('script');
      el.src = url;
      // No async/defer needed — we append at runtime and wait on the events.
      el.addEventListener('load', () => resolve());
      el.addEventListener('error', () => reject(new Error('script load failed: ' + url)));
      document.head.appendChild(el);
    });
  }

  async function loadMermaidOnce() {
    if (mermaidModule !== null) return mermaidModule;
    if (mermaidLoadPromise) return mermaidLoadPromise;
    mermaidLoadPromise = (async () => {
      try {
        // The vendored bundle ends with
        //   globalThis.mermaid = globalThis.__esbuild_esm_mermaid.default;
        // This only works when the bundle is loaded as a CLASSICAL script —
        // its top-level `var __esbuild_esm_mermaid = ...` must alias to
        // globalThis, which happens only at classical-script top level (not
        // under dynamic import(), where top-level var is module-local). So
        // we inject a <script src> tag rather than using import().
        await injectClassicalScript(MERMAID_BUNDLE_URL);
      } catch (e) {
        log.warn('mermaid bundle load failed:', e && e.message ? e.message : e);
        mermaidLoadPromise = null;
        throw e;
      }
      if (typeof window.mermaid === 'undefined') {
        mermaidLoadPromise = null;
        throw new Error('mermaid global missing after bundle load');
      }
      mermaidModule = window.mermaid;
      mermaidModule.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: pickMermaidTheme(),
        fontFamily: 'inherit',
      });
      return mermaidModule;
    })();
    return mermaidLoadPromise;
  }

  /**
   * Replace `wrapper`'s children with the SVG string returned by
   * `mermaid.render()`. The `wrapper.innerHTML = svgString` assignment
   * triggers CodeQL's js/xss-through-dom rule (Alert #4 on PR #19), which
   * is dismissed with this rationale:
   *
   *   1. mermaid.initialize({ securityLevel: 'strict' }) — Mermaid invokes
   *      DOMPurify INTERNALLY on every user-controlled label before
   *      emitting SVG. Strings reaching this assignment have already been
   *      sanitized by the same library CodeQL would recommend.
   *   2. ArtifactIframe runs with sandbox="allow-scripts allow-forms" (no
   *      allow-same-origin) — opaque origin, no access to Primer cookies,
   *      auth, parent DOM, or storage. Any script that did execute inside
   *      the iframe would be defanged.
   *   3. The artifact CSP at apps/api/src/routes/versionContent.ts sets
   *      connect-src 'none' — no network exfil from inside the iframe
   *      even if an XSS payload survived (1) and (2).
   *
   * A defense-in-depth pass via DOMPurify at this layer was attempted
   * (PR #19 commits 27dc7ac and 47d5545) but DOMPurify cannot preserve
   * the HTML content inside Mermaid's `<foreignObject>` text labels in
   * any tested config (svg-only, svg+html, ADD_TAGS, XHTML parser,
   * image/svg+xml parser) — the namespace transition is a known
   * limitation. The result was diagrams with no text. Both attempts
   * were reverted.
   */
  function safelySetSvgContent(wrapper, svgString) {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    wrapper.innerHTML = svgString;
  }

  /** Renders one <pre> block in place. Never throws — failures are inline. */
  async function renderOneMermaidBlock(preEl, mermaid) {
    const source = preEl.textContent || '';
    const id = 'primer-mermaid-' + (++mermaidRenderCounter);
    try {
      const result = await mermaid.render(id, source);
      const wrapper = document.createElement('div');
      wrapper.className = 'primer-mermaid';
      wrapper.setAttribute('data-mermaid-source', source);
      safelySetSvgContent(wrapper, result.svg);
      // Replace ALL children of <pre> with the wrapper.
      while (preEl.firstChild) preEl.removeChild(preEl.firstChild);
      preEl.appendChild(wrapper);
    } catch (e) {
      const msg = e && e.message ? e.message : 'render failed';
      // Leave the original block content intact; append a small error note.
      const note = document.createElement('div');
      note.className = 'primer-mermaid-error';
      note.textContent = 'Mermaid render failed: ' + msg;
      preEl.appendChild(note);
      log.warn('mermaid render failed for block', id, ':', msg);
    }
  }

  async function renderAllMermaidBlocks() {
    const blocks = findMermaidBlocks();
    if (blocks.length === 0) return;
    if (documentHasMermaidBootstrap()) {
      log.info('mermaid bootstrap detected in document, skipping');
      return;
    }
    let mermaid;
    try {
      mermaid = await loadMermaidOnce();
    } catch (_e) {
      // already logged in loadMermaidOnce
      return;
    }
    for (const pre of blocks) {
      await renderOneMermaidBlock(pre, mermaid);
    }
  }

  /** Re-render every already-rendered block using the current theme. */
  async function reRenderMermaidForTheme() {
    if (mermaidModule === null) return;
    const wrappers = document.querySelectorAll('[data-mermaid-source]');
    if (wrappers.length === 0) return;
    mermaidModule.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: pickMermaidTheme(),
      fontFamily: 'inherit',
    });
    for (const wrapper of wrappers) {
      const source = wrapper.getAttribute('data-mermaid-source') || '';
      const id = 'primer-mermaid-' + (++mermaidRenderCounter);
      try {
        const result = await mermaidModule.render(id, source);
        safelySetSvgContent(wrapper, result.svg);
      } catch (e) {
        // On theme-rerender failure, leave the prior SVG in place — silent.
        log.warn('mermaid re-render failed:', e && e.message ? e.message : e);
      }
    }
  }

  /** True when running in a UA without a hover-capable pointer (phones/tablets). */
  function isTouchUA() {
    try {
      return matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch (_) {
      return false;
    }
  }

  // WebKit (Safari + all iOS browsers) silently no-ops `behavior: 'smooth'`
  // in scrollTo/scrollIntoView inside cross-origin sandboxed iframes, which is
  // exactly the companion's context — the call returns with no error and no
  // scroll, so clicking a comment never reveals its anchor. Fall back to
  // instant scroll on WebKit. Chromium identifies as AppleWebKit via the
  // legacy UA token, so exclude it explicitly.
  const SCROLL_BEHAVIOR = (() => {
    try {
      const ua = navigator.userAgent || '';
      return /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua) ? 'auto' : 'smooth';
    } catch (_) {
      return 'smooth';
    }
  })();

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

    // Fire-and-forget — never blocks init or anchor rendering.
    renderAllMermaidBlocks().catch((e) =>
      log.warn('mermaid init render error:', e && e.message ? e.message : e),
    );

    // Apply parent-provided theme. Field is optional for backward-compat with
    // parents that haven't been updated yet (they won't set anything).
    if (incoming.theme === 'light' || incoming.theme === 'dark') {
      try {
        document.documentElement.dataset.theme = incoming.theme;
      } catch (e) {
        // documentElement should always exist; defensive catch.
      }
      // Re-render any Mermaid diagrams that finished before init resolved.
      reRenderMermaidForTheme().catch((e) =>
        log.warn('mermaid init theme re-render error:', e && e.message ? e.message : e),
      );
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
      case 'theme_changed':
        if (msg.theme === 'light' || msg.theme === 'dark') {
          try {
            document.documentElement.dataset.theme = msg.theme;
          } catch (e) {
            // defensive
          }
          // Re-render any existing Mermaid diagrams with the new theme.
          reRenderMermaidForTheme().catch((e) =>
            log.warn('mermaid theme re-render error:', e && e.message ? e.message : e),
          );
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

  // Collapse whitespace runs to single spaces WITHOUT trimming the outer
  // edges. Used at capture time so the prefix/suffix preserve a single
  // boundary space between them and the selectorText — otherwise the
  // needle reconstructed at resolution time would miss the space that's
  // actually in the document at the join points.
  // See apps/api/src/companion/textRangeResolution.test.ts for the math.
  function collapseWhitespace(s) {
    return s.replace(/\s+/g, ' ');
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
    const beforeN = collapseWhitespace(beforeRaw).slice(-n);
    const afterN = collapseWhitespace(afterRaw).slice(0, n);
    return { prefix: beforeN, suffix: afterN };
  }

  // ── Position-based anchoring (W3C TextPositionSelector style) ────
  //
  // Artifacts are immutable per version, so we anchor text-range
  // comments by raw cumulative character offsets into the flattened
  // text walk of document.body. Capture: range endpoints → (start, end)
  // integers. Resolve: (start, end) → DOM Range. Cross-block,
  // cross-cell, repeated-text, and whitespace edge cases dissolve.
  //
  // The pure math is mirrored in apps/api/src/companion/textRangePosition.test.ts.
  // Keep the two in sync — especially the boundary convention in
  // offsetToEndpoint (offsets at a segment boundary belong to the
  // earlier segment, matching Range.setEnd at end-of-node).

  /** Ids of DOM injected by the companion. Text nodes inside any of
   *  these subtrees are excluded from the segment index so our own
   *  badges / banner do not shift offsets. */
  const COMPANION_DOM_IDS = new Set([
    '__primer_overlay__',         // appended to document.body
    '__primer_pick_banner__',     // appended to document.body
    '__primer_companion_style__', // in document.head — excluded for completeness
  ]);

  /** Cached segment index. Built lazily on first call to getSegments().
   *  Never invalidated: artifact DOM is immutable, companion DOM is
   *  excluded from the walk, so the index is stable for the lifetime
   *  of the iframe.
   *  @type {{ node: Text, start: number, end: number }[] | null} */
  let _segmentsCache = null;

  /** NodeFilter that rejects text nodes whose ancestor is a subtree
   *  we've injected (overlay, banner, style). Used by every text walker
   *  in the position-based anchoring path so capture, resolution, and
   *  Element-endpoint descent all agree on which text nodes count. */
  function makeCompanionExcludeFilter() {
    return {
      acceptNode(node) {
        let p = node.parentElement;
        while (p) {
          if (p.id && COMPANION_DOM_IDS.has(p.id)) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    };
  }

  function getSegments() {
    if (_segmentsCache) return _segmentsCache;
    /** @type {{ node: Text, start: number, end: number }[]} */
    const out = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      makeCompanionExcludeFilter()
    );
    let cursor = 0;
    let n = walker.nextNode();
    while (n) {
      const t = /** @type {Text} */ (n);
      const len = t.nodeValue.length;
      out.push({ node: t, start: cursor, end: cursor + len });
      cursor += len;
      n = walker.nextNode();
    }
    _segmentsCache = out;
    return out;
  }

  function findFirstTextDescendant(node) {
    if (node instanceof Text) return node;
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      makeCompanionExcludeFilter()
    );
    return /** @type {Text | null} */ (walker.nextNode());
  }

  function findLastTextDescendant(node) {
    if (node instanceof Text) return node;
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      makeCompanionExcludeFilter()
    );
    /** @type {Text | null} */
    let last = null;
    /** @type {Node | null} */
    let n = walker.nextNode();
    while (n) {
      last = /** @type {Text} */ (n);
      n = walker.nextNode();
    }
    return last;
  }

  /** Map (containerNode, intra-node offset) → raw cumulative offset.
   *  If containerNode is an Element, descends into childNodes[offset]
   *  and walks to the first text descendant (== "position at start of
   *  that subtree's text"). If offset is past the last child, returns
   *  the end of the element's last text descendant. Returns -1 if no
   *  mapping found. */
  function endpointToOffset(containerNode, offset) {
    const segs = getSegments();
    if (containerNode instanceof Text) {
      for (const seg of segs) {
        if (seg.node === containerNode) {
          const clamped = Math.max(0, Math.min(offset, seg.end - seg.start));
          return seg.start + clamped;
        }
      }
      return -1;
    }
    if (!(containerNode instanceof Element)) return -1;
    const children = containerNode.childNodes;
    if (offset >= children.length) {
      const lastText = findLastTextDescendant(containerNode);
      if (!lastText) return -1;
      for (const seg of segs) {
        if (seg.node === lastText) return seg.end;
      }
      return -1;
    }
    const child = children[offset];
    const firstText = child instanceof Text ? child : findFirstTextDescendant(child);
    if (!firstText) return -1;
    for (const seg of segs) {
      if (seg.node === firstText) return seg.start;
    }
    return -1;
  }

  /** Map a raw cumulative offset → (Text node, intra-node offset).
   *  Boundary convention: an offset that sits on a segment boundary
   *  (== seg.start of the current segment AND == segs[mid-1].end of the
   *  previous segment) belongs to the EARLIER segment. Matches
   *  Range.setEnd's behavior where setEnd(node, node.length) and
   *  setStart(nextNode, 0) refer to the same document position; we
   *  always pick the former. Also handles empty text nodes where
   *  seg.start == seg.end.
   *  Returns null if out of bounds or segments are empty. */
  function offsetToEndpoint(rawOffset) {
    const segs = getSegments();
    if (segs.length === 0) return null;
    const last = segs[segs.length - 1];
    if (rawOffset < 0 || rawOffset > last.end) return null;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid];
      if (rawOffset < seg.start) hi = mid - 1;
      else if (rawOffset > seg.end) lo = mid + 1;
      else {
        if (rawOffset === seg.start && mid > 0 && segs[mid - 1].end === rawOffset) {
          const prev = segs[mid - 1];
          return { node: prev.node, offset: rawOffset - prev.start };
        }
        return { node: seg.node, offset: rawOffset - seg.start };
      }
    }
    // Unreachable: the bounds check above guarantees rawOffset ∈ [0, last.end],
    // and the segment array is contiguous by construction, so every valid
    // offset is found inside some segment. Kept as a defensive tail.
    return null;
  }

  /** Build a DOM Range from raw (start, end) offsets. Returns null if
   *  either endpoint can't be mapped or end < start. */
  function rangeFromOffsets(start, end) {
    if (end < start) return null;
    const a = offsetToEndpoint(start);
    const b = offsetToEndpoint(end);
    if (!a || !b) return null;
    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch {
      return null;
    }
  }

  // ── Selection capture ────────────────────────────────────────────

  let lastEmittedFingerprint = '';
  let lastEmittedAt = 0;
  let hasActiveCapture = false;

  function emitSelectionCleared() {
    if (!port || !hasActiveCapture) return;
    hasActiveCapture = false;
    lastEmittedFingerprint = '';
    port.postMessage({ type: 'selection_cleared' });
  }

  function onPossibleSelection() {
    if (!port) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      emitSelectionCleared();
      return;
    }

    const range = sel.getRangeAt(0);
    const selectorText = sel.toString();
    if (selectorText.trim().length === 0) {
      emitSelectionCleared();
      return;
    }

    // Reject selections that started or ended inside companion-injected
    // DOM (overlay badges, pick banner). endpointToOffset would return
    // -1 anyway, but bailing early keeps the capture path quiet.
    if (
      isInCompanionDom(range.startContainer) ||
      isInCompanionDom(range.endContainer)
    ) {
      return;
    }

    const start = endpointToOffset(range.startContainer, range.startOffset);
    const end = endpointToOffset(range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) {
      log.info('selection capture skipped — endpoints unmappable', { start, end });
      return;
    }

    const fingerprint = `${start}|${end}`;
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
        start,
        end,
        selectorText,
      },
      clientRects,
    });
    hasActiveCapture = true;
  }

  /** True if `node` is inside any companion-injected subtree. Shares
   *  COMPANION_DOM_IDS with makeCompanionExcludeFilter — register new
   *  companion roots there and both paths pick them up automatically. */
  function isInCompanionDom(node) {
    let p = node instanceof Element ? node : node.parentElement;
    while (p) {
      if (p.id && COMPANION_DOM_IDS.has(p.id)) return true;
      p = p.parentElement;
    }
    return false;
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

  /** Resolve a text-range anchor to a DOM Range. Dispatches on shape:
   *  position-based anchors (start/end integers) use the segment-index
   *  helpers; legacy anchors (prefix / selectorText / suffix /
   *  containerPath) use the text-pattern matcher. Returns null if
   *  unresolvable. New captures (post-Task 4) always carry start/end;
   *  pre-existing stored anchors carry the legacy fields. */
  function resolveTextRange(anchor) {
    if (
      typeof anchor.start === 'number' &&
      typeof anchor.end === 'number' &&
      Number.isFinite(anchor.start) &&
      Number.isFinite(anchor.end)
    ) {
      return rangeFromOffsets(anchor.start, anchor.end);
    }
    if (typeof anchor.containerPath === 'string') {
      return resolveTextRangeLegacy(anchor);
    }
    return null;
  }

  function resolveTextRangeLegacy(anchor) {
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
    const cPrefix = collapseWhitespace(anchor.prefix);
    const cSelector = collapseWhitespace(anchor.selectorText);
    const cSuffix = collapseWhitespace(anchor.suffix);
    const cFull = cPrefix + cSelector + cSuffix;
    // The needle aligns with normalizedRaw, which is fully normalized
    // (outer ends trimmed). cFull is already run-collapsed so we only
    // strip the outer edges.
    const needle = cFull.replace(/^\s+|\s+$/g, '');
    const hit = normalizedRaw.indexOf(needle);
    if (hit === -1) return null;

    // Account for whitespace at the outer ends of cFull that got trimmed
    // from the needle. The trim eats cPrefix/cSuffix first, then chews
    // into cSelector if either is empty. Selection.toString() in
    // Chrome/Brave inserts a "\n" at touched block boundaries (triple-
    // click on a list item, shift+extend past a paragraph end), which
    // becomes trailing whitespace in cSelector — without the trim
    // adjustment the rawEnd math overshoots the actual normalized raw
    // length and returns -1, drifting the anchor.
    const leadingTrim = cFull.length - cFull.replace(/^\s+/, '').length;
    const trailingTrim = cFull.length - cFull.replace(/\s+$/, '').length;
    const leadingChopFromSelector = Math.max(0, leadingTrim - cPrefix.length);
    const trailingChopFromSelector = Math.max(0, trailingTrim - cSuffix.length);
    const selStart = Math.max(0, cPrefix.length - leadingTrim);
    const selLength = Math.max(
      0,
      cSelector.length - leadingChopFromSelector - trailingChopFromSelector,
    );

    const rawStart = mapNormalizedToRaw(raw, hit + selStart);
    const rawEnd = mapNormalizedToRaw(raw, hit + selStart + selLength);
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
    // A whitespace run contributes one normalized char and advances i
    // past the entire run, so the returned position lands on the first
    // non-whitespace character after the run (not mid-run).
    let i = 0;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    let nIdx = 0;
    while (i < raw.length && nIdx < normalizedOffset) {
      if (/\s/.test(raw[i])) {
        while (i < raw.length && /\s/.test(raw[i])) i++;
        nIdx++;
      } else {
        i++;
        nIdx++;
      }
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
          // Scroll to the range's actual visual position. Using
          // startContainer.parentElement is wrong when the resolver
          // landed start at the end of a whitespace text node between
          // elements — that node's parent is a far ancestor (article,
          // body), not the meaningful target. The bounding rect is
          // where the user actually wants to look. Also handles ranges
          // that span multiple elements (cross-cell, cross-paragraph)
          // by centering on the rect spanning all of them.
          const rect = nextRange.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            const targetY = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
            window.scrollTo({ top: Math.max(0, targetY), behavior: SCROLL_BEHAVIOR });
          } else {
            // Fallback for ranges with no client rects (e.g., inside
            // display:none subtree — unexpected for visible artifact
            // content, but defensive).
            const start = nextRange.startContainer;
            const parentEl = start instanceof Element ? start : start.parentElement;
            parentEl?.scrollIntoView({ behavior: SCROLL_BEHAVIOR, block: 'center' });
          }
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
          nextEntry.el.scrollIntoView({ behavior: SCROLL_BEHAVIOR, block: 'center' });
        } catch {}
      }
    }
  }

  // ── Click-to-focus ───────────────────────────────────────────────
  // Clicking on a highlighted span (text-range) or a tracked element
  // (element-path) tells the parent to focus the matching thread.
  // No preventDefault — the artifact's own click handlers still run.

  let caretApiWarned = false;
  function warnNoCaretApiOnce() {
    if (caretApiWarned) return;
    caretApiWarned = true;
    log.warn('caretRangeFromPoint and caretPositionFromPoint both unavailable; click hit-test on text ranges disabled');
  }

  /**
   * Caret-based hit-test for text-range anchors. Uses the browser's own
   * caret-positioning logic (caretRangeFromPoint / caretPositionFromPoint)
   * and Range.comparePoint to decide which range — if any — contains the
   * click point. Overlapping ranges resolve to the smallest containing one.
   *
   * Returns the anchorId of the matching text-range anchor, or null.
   */
  function findTextRangeAtClick(event) {
    const x = event.clientX;
    const y = event.clientY;

    // Cheap reject: if no range's bounding box contains the click, skip the
    // caret lookup entirely. Bails out fast on the common case (click is
    // outside any highlight).
    let anyRectHit = false;
    outer: for (const range of rangeByAnchorId.values()) {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          anyRectHit = true;
          break outer;
        }
      }
    }
    if (!anyRectHit) return null;

    // Authoritative lookup via caret API.
    let caretNode = null;
    let caretOffset = 0;
    if (typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { caretNode = r.startContainer; caretOffset = r.startOffset; }
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { caretNode = p.offsetNode; caretOffset = p.offset; }
    } else {
      warnNoCaretApiOnce();
    }
    if (!caretNode) return null;

    let best = null;
    let bestLength = Infinity;
    for (const [anchorId, range] of rangeByAnchorId) {
      let inside = false;
      try {
        inside = range.comparePoint(caretNode, caretOffset) === 0;
      } catch (e) {
        // Range.comparePoint throws WrongDocumentError / InvalidNodeTypeError
        // on cross-document or bad-typed nodes. Neither is reachable with
        // caret API output, but catch defensively.
      }
      if (!inside) continue;
      const len = range.toString().length;
      if (len < bestLength) {
        best = anchorId;
        bestLength = len;
      }
    }
    return best;
  }

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
    // Iterate the map; first match wins (these don't overlap in practice).
    for (const [anchorId, entry] of elementByAnchorId) {
      if (entry.el.contains(target)) return anchorId;
    }

    // Text-range: delegate to caret-based hit-test (more reliable than rects).
    return findTextRangeAtClick(event);
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

  const PICK_BANNER_ID = '__primer_pick_banner__';

  function ensurePickBanner() {
    let el = document.getElementById(PICK_BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PICK_BANNER_ID;
    el.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'background:#111',
      'color:#fff',
      'font:14px/1.4 system-ui, sans-serif',
      'padding:10px 14px',
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:12px',
    ].join(';') + ';';
    el.innerHTML = '<span>Tap an element to add a comment</span>';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:transparent;color:#fff;border:1px solid #555;padding:4px 10px;border-radius:4px;font:inherit;cursor:pointer;';
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      exitPickMode('banner');
    }, true);
    el.appendChild(cancel);
    document.body.appendChild(el);
    return el;
  }

  function removePickBanner() {
    const el = document.getElementById(PICK_BANNER_ID);
    if (el) el.remove();
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

    if (isTouchUA()) {
      // Touch UAs: no outline preview (finger covers it), use `pointer` cursor
      // so iOS Safari reliably synthesizes click on non-button elements.
      document.body.style.cursor = 'pointer';
      ensurePickBanner();
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('touchend', onPickTouchEnd, true);
    } else {
      document.body.style.cursor = 'crosshair';
      pickOutline = document.createElement('div');
      pickOutline.className = '__primer_pick_outline__';
      ensureOverlay().appendChild(pickOutline);
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
    }
  }

  function exitPickMode(reason /* 'click' | 'esc' | 'parent' | 'banner' */) {
    if (!pickActive) return;
    pickActive = false;
    _pickInFlight = false;
    document.body.style.cursor = prevBodyCursor;
    pickOutline?.remove();
    pickOutline = null;
    removePickBanner();

    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('touchend', onPickTouchEnd, true);
    document.removeEventListener('keydown', onPickKey, true);

    // 'click' exits are implicit in element_picked; 'parent' was parent-initiated.
    // 'esc' and 'banner' are user-initiated from inside the iframe — parent
    // needs an explicit pick_mode_exited to revert its UI.
    if ((reason === 'esc' || reason === 'banner') && port) {
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

  let _pickInFlight = false;

  function onPickTouchEnd(e) {
    if (!pickActive || _pickInFlight) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const target = document.elementFromPoint(t.clientX, t.clientY);
    if (!(target instanceof Element)) return;
    if (target.closest('#' + PICK_BANNER_ID)) return;
    _pickInFlight = true;
    // Synthesize the same flow as onPickClick.
    e.preventDefault();
    e.stopImmediatePropagation();
    void commitPick(target).finally(() => { _pickInFlight = false; });
  }

  async function onPickClick(e) {
    if (!pickActive || _pickInFlight) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    _pickInFlight = true;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      await commitPick(target);
    } finally {
      _pickInFlight = false;
    }
  }

  async function commitPick(target) {
    const path = cssPath(target);
    const rawText = normalize(target.textContent ?? '');
    const innerHash = (await sha256Hex(rawText)).slice(0, 16);
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
