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

export function fragmentFor(doc: Y.Doc, target: Target): Y.XmlFragment {
  return doc.getXmlFragment(fragmentName(target));
}

export function isTabFragment(name: string): boolean {
  return name === MAIN_FRAGMENT || name.startsWith('tab/');
}

export type Tab = { id: string; title: string };

/**
 * The document's tabs in order, `main` first. Editors write the `tabs` array
 * directly, so entries are checked: malformed or repeated ones are skipped,
 * and `main` is always there (a document without `tabs` has only `main`).
 * Removing a tab from the array deletes it; its fragment stays in the Y.Doc,
 * unreachable, so its comment marks no longer count.
 */
export function tabsOf(doc: Y.Doc): Tab[] {
  const tabs: Tab[] = [{ id: MAIN_TAB, title: '' }];
  const seen = new Set([MAIN_TAB]);
  for (const entry of doc.getArray<unknown>('tabs').toArray()) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || typeof title !== 'string') continue;
    if (id === MAIN_TAB) {
      tabs[0] = { id, title: title.slice(0, 200) };
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    tabs.push({ id, title: title.slice(0, 200) });
  }
  return tabs;
}

/**
 * Every fragment current content can reach: each tab's fragment, plus the
 * page, embed and widget fragments that current content references (added as
 * those blocks land). Fragments a republish left behind stay in the Y.Doc but
 * are unreachable.
 */
export function reachableFragments(doc: Y.Doc): string[] {
  return tabsOf(doc).map((tab) => tabFragmentName(tab.id));
}
