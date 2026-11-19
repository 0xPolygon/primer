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

/** A page block of a live document (packages/blocks page.tsx), as its props
 *  read: editor-writable, so ids are checked and the source key is only a
 *  candidate until the server checks it against the document. */
export type PageRef = { tabId: string; blockId: string; sourceKey: string; title: string; pids: string[]; embeds: string[] };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ids = (raw: unknown) => (typeof raw === 'string' ? raw.split(' ').filter((id) => ID.test(id)) : []);

/** Every page block in the document's tabs, in order. */
export function pageBlocks(doc: Y.Doc): PageRef[] {
  const out: PageRef[] = [];
  for (const tab of tabsOf(doc)) {
    const walk = (node: Y.XmlFragment | Y.XmlElement, blockId: string | null): void => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === 'blockContainer') {
          const id = child.getAttribute('id');
          walk(child, typeof id === 'string' ? id : null);
        } else if (child.nodeName === 'page' && blockId && ID.test(blockId)) {
          const attr = (name: string) => child.getAttribute(name) as unknown;
          out.push({
            tabId: tab.id,
            blockId,
            sourceKey: typeof attr('sourceKey') === 'string' ? (attr('sourceKey') as string) : '',
            title: typeof attr('title') === 'string' ? (attr('title') as string) : '',
            pids: ids(attr('pids')),
            embeds: ids(attr('embeds')),
          });
        } else {
          walk(child, blockId);
        }
      }
    };
    walk(doc.getXmlFragment(tabFragmentName(tab.id)), null);
  }
  return out;
}

/**
 * Every fragment current content can reach: each tab's fragment, plus the
 * page text and embed fragments of the page blocks in them (widget fragments
 * are added as widgets land). Fragments a republish left behind stay in the
 * Y.Doc but are unreachable.
 */
export function reachableFragments(doc: Y.Doc): string[] {
  const names = tabsOf(doc).map((tab) => tabFragmentName(tab.id));
  for (const page of pageBlocks(doc)) {
    for (const pid of page.pids) names.push(fragmentName({ tabId: page.tabId, blockId: page.blockId, pid }));
    for (const embedId of page.embeds) names.push(fragmentName({ tabId: page.tabId, blockId: page.blockId, embedId }));
  }
  for (const tab of tabsOf(doc)) widgetLabelFragments(doc.getXmlFragment(tabFragmentName(tab.id)), names);
  return names;
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
