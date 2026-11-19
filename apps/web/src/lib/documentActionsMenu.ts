export type MenuItemId =
  | 'share'
  | 'open-fullscreen'
  | 'download-html'
  | 'export-markdown'
  | 'export-html'
  | 'export-print'
  | 'notebooklm'
  | 'copy'
  | 'download'
  | 'separator'
  | 'delete';

export interface MenuItem {
  id: MenuItemId;
  label?: string;
  destructive?: boolean;
}

export interface MenuInput {
  isUploader: boolean;
  /** Mobile collapses the Share button into the menu. */
  includeShare?: boolean;
  /** Live documents export their content (Markdown or text, and HTML). */
  live?: boolean;
}

/** Pure function: given who's viewing, return the ordered menu items. The
 *  caller maps each item to a click handler. */
export function buildMenuItems({ isUploader, includeShare = false, live = false }: MenuInput): MenuItem[] {
  const items: MenuItem[] = [];
  if (includeShare && isUploader) {
    items.push({ id: 'share', label: 'Share…' });
    items.push({ id: 'separator' });
  }
  if (live) {
    items.push(
      { id: 'export-markdown', label: 'Export Markdown' },
      { id: 'export-html', label: 'Export HTML' },
      { id: 'export-print', label: 'Print / PDF' },
      { id: 'separator' },
    );
  }
  items.push(
    { id: 'open-fullscreen', label: 'Open full screen' },
    { id: 'download-html', label: 'Download HTML' },
    { id: 'notebooklm', label: 'Send to NotebookLM…' },
    { id: 'separator' },
    { id: 'copy', label: 'Copy comments as Markdown' },
    { id: 'download', label: 'Download comments as Markdown' },
  );
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: 'Delete document…', destructive: true });
  }
  return items;
}
