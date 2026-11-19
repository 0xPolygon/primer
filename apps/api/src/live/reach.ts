import * as Y from 'yjs';
import type { Target } from '@polygonlabs/primer-api-types';

/** The main tab's fragment keeps BlockNote's default name. */
export const MAIN_TAB = 'main';
const MAIN_FRAGMENT = 'document-store';

export function tabFragmentName(tabId: string): string {
  return tabId === MAIN_TAB ? MAIN_FRAGMENT : `tab/${tabId}`;
}

/** The Y.XmlFragment name a Target lives in (C3), most specific first. */
export function fragmentName(target: Target): string {
  if (target.pid) return `page/${target.blockId}/${target.pid}`;
  if (target.embedId) return `embed/${target.blockId}/${target.embedId}`;
  if (target.textId) return `widget/${target.blockId}/${target.textId}`;
  return tabFragmentName(target.tabId);
}

/** The Target of a sub-fragment name (`page/…`, `embed/…`, `widget/…`), or
 *  null for a tab fragment. The inverse of `fragmentName`. */
export function targetOfFragment(name: string, tabId: string = MAIN_TAB): Target | null {
  const [kind, blockId, sub] = name.split('/');
  if (!blockId || !sub) return null;
  if (kind === 'page') return { tabId, blockId, pid: sub };
  if (kind === 'embed') return { tabId, blockId, embedId: sub };
  if (kind === 'widget') return { tabId, blockId, textId: sub };
  return null;
}

export function fragmentFor(doc: Y.Doc, target: Target): Y.XmlFragment {
  return doc.getXmlFragment(fragmentName(target));
}

export function isTabFragment(name: string): boolean {
  return name === MAIN_FRAGMENT || name.startsWith('tab/');
}

/** The document's tabs, `main` first. A document without a `tabs` entry has
 *  only `main`. */
export function tabsOf(doc: Y.Doc): { id: string; title: string }[] {
  const tabs = doc.getArray<{ id: string; title: string }>('tabs').toArray();
  return tabs.length > 0 ? tabs : [{ id: MAIN_TAB, title: '' }];
}

/**
 * Every fragment current content can reach: each tab's fragment, plus the
 * page, embed and widget fragments that current content references (added as
 * those blocks land). Fragments a republish left behind stay in the Y.Doc but
 * are unreachable.
 */
export function reachableFragments(doc: Y.Doc): string[] {
  return tabsOf(doc).flatMap((tab) => {
    const name = tabFragmentName(tab.id);
    return [name, ...widgetLabelFragments(doc.getXmlFragment(name))];
  });
}

/** The label fragments (`widget/<blockId>/<textId>`) of the widget blocks in
 *  a tab: each block lists its published text ids in its `textIds` prop. */
export function widgetLabelFragments(fragment: Y.XmlFragment | Y.XmlElement, out: string[] = []): string[] {
  for (const child of fragment.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === 'widget') {
      const blockId = (child.parent as Y.XmlElement | null)?.getAttribute('id');
      const textIds = String(child.getAttribute('textIds') ?? '').split(' ').filter(Boolean);
      if (blockId) for (const textId of textIds) out.push(fragmentName({ tabId: '', blockId, textId }));
    } else {
      widgetLabelFragments(child, out);
    }
  }
  return out;
}
