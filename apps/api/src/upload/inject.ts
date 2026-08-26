import type { DefaultTreeAdapterMap } from 'parse5';
import { STORAGE_POLYFILL_JS } from './storagePolyfill.ts';
import { EVENT_GUARD_SHIM_JS } from './eventGuardShim.ts';

type Document = DefaultTreeAdapterMap['document'];
type Element = DefaultTreeAdapterMap['element'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type TextNode = DefaultTreeAdapterMap['textNode'];

function findHtml(doc: Document): Element | null {
  return (
    doc.childNodes.find(
      (n): n is Element => (n as Element).tagName === 'html'
    ) ?? null
  );
}

function findBody(doc: Document): Element | null {
  const html = findHtml(doc);
  if (!html) return null;
  return (
    html.childNodes.find(
      (n): n is Element => (n as Element).tagName === 'body'
    ) ?? null
  );
}

function findHead(doc: Document): Element | null {
  const html = findHtml(doc);
  if (!html) return null;
  return (
    html.childNodes.find(
      (n): n is Element => (n as Element).tagName === 'head'
    ) ?? null
  );
}

export function injectCompanionScript(doc: Document): void {
  const body = findBody(doc);
  if (!body) {
    throw new Error('document has no <body> after parse5 normalization');
  }

  const scriptEl: Element = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [
      { name: 'src', value: '/companion/v1.js' },
      { name: 'defer', value: '' },
    ],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [],
    parentNode: body,
  } as unknown as Element;

  body.childNodes.push(scriptEl as ChildNode);
}

// Injects a responsive viewport <meta> into <head> when the artifact doesn't
// already declare one. LLM-generated artifacts frequently omit
// `<meta name="viewport">`, so mobile browsers lay them out at the default
// ~980px viewport inside the sandboxed iframe — producing the horizontal
// scroll / "zoomed out" reading experience on phones. We only inject when the
// author did NOT specify a viewport, so intentional viewport choices are
// preserved. Appended (not unshifted) so a `<meta charset>` stays within the
// first bytes of <head> for early encoding detection.
export function injectViewportMeta(doc: Document): void {
  const head = findHead(doc);
  if (!head) {
    throw new Error('document has no <head> after parse5 normalization');
  }

  const hasViewport = head.childNodes.some(
    (n) =>
      (n as Element).tagName === 'meta' &&
      (n as Element).attrs?.some(
        (a) => a.name.toLowerCase() === 'name' && a.value.toLowerCase() === 'viewport',
      ),
  );
  if (hasViewport) return;

  const metaEl: Element = {
    nodeName: 'meta',
    tagName: 'meta',
    attrs: [
      { name: 'name', value: 'viewport' },
      { name: 'content', value: 'width=device-width, initial-scale=1' },
    ],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [],
    parentNode: head,
  } as unknown as Element;

  head.childNodes.push(metaEl as ChildNode);
}

// Marks the artifact as Primer-theme-managed by setting
// `data-primer-theme="managed"` on <html>. The companion (v1.js) forces the
// parent app's light/dark theme onto an artifact ONLY when this marker is
// present. Self-themed HTML artifacts (which drive their own `data-theme` via
// an in-artifact toggle) are left unmarked, so the companion never clobbers
// their theme — that clobbering desyncs the artifact's own toggle from what's
// displayed. Applied only to Primer-authored content (Markdown); see
// transformHtml's `themeManaged` option.
export function injectThemeOwnershipMarker(doc: Document): void {
  const html = findHtml(doc);
  if (!html) {
    throw new Error('document has no <html> after parse5 normalization');
  }
  const existing = html.attrs.find((a) => a.name === 'data-primer-theme');
  if (existing) {
    existing.value = 'managed';
    return;
  }
  html.attrs.push({ name: 'data-primer-theme', value: 'managed' });
}

// Injects an inline <script> with the storage polyfill source as the FIRST
// child of <head>. Must be parser-blocking (no `src`, no `defer`, no `async`)
// so it runs before any artifact <script> in either <head> or <body> —
// including top-level reads of `localStorage` that would otherwise throw
// SecurityError in the opaque-origin iframe sandbox. See storagePolyfill.ts
// for the rationale and issue #25 for the failure mode.
export function injectStoragePolyfill(doc: Document): void {
  unshiftInlineHeadScript(doc, STORAGE_POLYFILL_JS);
}

// Injects the event-guard shim as the VERY FIRST child of <head>
// (parser-blocking inline script), so it runs before any artifact script —
// including before the storage polyfill, which is why this must be called
// LAST among the head-unshifting injectors. The shim pins
// `Event.prototype.eventPhase` (and MessageEvent's source/ports/data)
// non-configurable so a hostile artifact cannot poison the getter the
// companion's consent gate reads to detect an in-progress gesture dispatch.
// See eventGuardShim.ts for the full rationale and the property audit.
export function injectEventGuardShim(doc: Document): void {
  unshiftInlineHeadScript(doc, EVENT_GUARD_SHIM_JS);
}

// Shared helper: prepend a parser-blocking inline <script> (no src/defer/
// async) as the first child of <head>. The most recently unshifted script
// runs first, so call order among unshifters is reverse of run order.
function unshiftInlineHeadScript(doc: Document, source: string): void {
  const head = findHead(doc);
  if (!head) {
    throw new Error('document has no <head> after parse5 normalization');
  }

  const scriptEl: Element = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [],
    parentNode: head,
  } as unknown as Element;

  const textNode: TextNode = {
    nodeName: '#text',
    value: source,
    parentNode: scriptEl,
  } as unknown as TextNode;

  scriptEl.childNodes.push(textNode as ChildNode);
  head.childNodes.unshift(scriptEl as ChildNode);
}
