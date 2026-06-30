import type { DefaultTreeAdapterMap } from 'parse5';
import { STORAGE_POLYFILL_JS } from './storagePolyfill.ts';

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

// Injects an inline <script> with the storage polyfill source as the FIRST
// child of <head>. Must be parser-blocking (no `src`, no `defer`, no `async`)
// so it runs before any artifact <script> in either <head> or <body> —
// including top-level reads of `localStorage` that would otherwise throw
// SecurityError in the opaque-origin iframe sandbox. See storagePolyfill.ts
// for the rationale and issue #25 for the failure mode.
export function injectStoragePolyfill(doc: Document): void {
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
    value: STORAGE_POLYFILL_JS,
    parentNode: scriptEl,
  } as unknown as TextNode;

  scriptEl.childNodes.push(textNode as ChildNode);
  head.childNodes.unshift(scriptEl as ChildNode);
}
