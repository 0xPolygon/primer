import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type ChildNode = DefaultTreeAdapterMap['childNode'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

function isElement(n: Node): n is Element {
  return (n as Element).tagName !== undefined;
}

function hasChildNodes(n: Node): n is ParentNode {
  return (n as ParentNode).childNodes !== undefined;
}

function isMetaRefresh(el: Element): boolean {
  if (el.tagName !== 'meta') return false;
  const attr = el.attrs.find((a) => a.name.toLowerCase() === 'http-equiv');
  return !!attr && attr.value.trim().toLowerCase() === 'refresh';
}

function shouldStrip(el: Element): boolean {
  return el.tagName === 'iframe' || isMetaRefresh(el);
}

export function stripDisallowedElements(root: Node): void {
  if (!hasChildNodes(root)) return;
  const keep: ChildNode[] = [];
  for (const child of root.childNodes) {
    if (isElement(child) && shouldStrip(child)) continue;
    stripDisallowedElements(child);
    keep.push(child);
  }
  root.childNodes = keep;
}
