import * as Y from 'yjs';

/** A document's tab (the Y.Doc's `tabs` array; apps/api/src/live/reach.ts). */
export type Tab = { id: string; title: string };

export const MAIN_TAB = 'main';

/** The Y.XmlFragment a tab's content lives in. */
export function tabFragmentName(tabId: string): string {
  return tabId === MAIN_TAB ? 'document-store' : `tab/${tabId}`;
}

/** The tabs in order, `main` first, read as the server reads them. */
export function readTabs(doc: Y.Doc): Tab[] {
  const tabs: Tab[] = [{ id: MAIN_TAB, title: '' }];
  const seen = new Set([MAIN_TAB]);
  for (const entry of doc.getArray<unknown>('tabs').toArray()) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || typeof title !== 'string') continue;
    if (id === MAIN_TAB) tabs[0] = { id, title: title.slice(0, 200) };
    else if (!seen.has(id)) {
      seen.add(id);
      tabs.push({ id, title: title.slice(0, 200) });
    }
  }
  return tabs;
}

/** Replaces the tab list in one transaction (it syncs like any edit). */
function writeTabs(doc: Y.Doc, tabs: Tab[]): void {
  doc.transact(() => {
    const array = doc.getArray<Tab>('tabs');
    array.delete(0, array.length);
    array.push(tabs);
  });
}

export function addTab(doc: Y.Doc, title: string): Tab {
  const tab = { id: crypto.randomUUID(), title };
  writeTabs(doc, [...readTabs(doc), tab]);
  return tab;
}

export function renameTab(doc: Y.Doc, id: string, title: string): void {
  writeTabs(doc, readTabs(doc).map((t) => (t.id === id ? { ...t, title } : t)));
}

/** Deletes a tab (never `main`). Its content stays in the Y.Doc, unreachable. */
export function deleteTab(doc: Y.Doc, id: string): void {
  if (id === MAIN_TAB) return;
  writeTabs(doc, readTabs(doc).filter((t) => t.id !== id));
}
