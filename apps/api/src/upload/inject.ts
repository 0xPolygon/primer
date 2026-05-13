import type { DefaultTreeAdapterMap } from 'parse5';

type Document = DefaultTreeAdapterMap['document'];
type Element = DefaultTreeAdapterMap['element'];
type ChildNode = DefaultTreeAdapterMap['childNode'];

function findBody(doc: Document): Element | null {
  const html = doc.childNodes.find(
    (n): n is Element => (n as Element).tagName === 'html'
  );
  if (!html) return null;
  return (
    html.childNodes.find(
      (n): n is Element => (n as Element).tagName === 'body'
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
