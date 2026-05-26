export type MenuItemId = 'copy' | 'download' | 'separator' | 'delete';

export interface MenuItem {
  id: MenuItemId;
  label?: string;
  destructive?: boolean;
}

export interface MenuInput {
  isUploader: boolean;
}

/** Pure function: given who's viewing, return the ordered menu items. The
 *  caller maps each item to a click handler. */
export function buildMenuItems({ isUploader }: MenuInput): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'copy', label: 'Copy comments as Markdown' },
    { id: 'download', label: 'Download comments as Markdown' },
  ];
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: 'Delete document…', destructive: true });
  }
  return items;
}
