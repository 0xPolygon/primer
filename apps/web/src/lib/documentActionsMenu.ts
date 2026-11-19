import { t } from '../i18n';
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
    items.push({ id: 'share', label: t('libDocumentActionsMenu.share') });
    items.push({ id: 'separator' });
  }
  if (live) {
    items.push(
      { id: 'export-markdown', label: t('libDocumentActionsMenu.exportMarkdown') },
      { id: 'export-html', label: t('libDocumentActionsMenu.exportHtml') },
      { id: 'export-print', label: t('libDocumentActionsMenu.printPdf') },
      { id: 'separator' },
    );
  }
  items.push(
    { id: 'open-fullscreen', label: t('libDocumentActionsMenu.openFullScreen') },
    { id: 'download-html', label: t('libDocumentActionsMenu.downloadHtml') },
    { id: 'notebooklm', label: t('libDocumentActionsMenu.sendToNotebookLm') },
    { id: 'separator' },
    { id: 'copy', label: t('libDocumentActionsMenu.copyCommentsAsMarkdown') },
    { id: 'download', label: t('libDocumentActionsMenu.downloadCommentsAsMarkdown') },
  );
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: t('libDocumentActionsMenu.deleteDocument'), destructive: true });
  }
  return items;
}
