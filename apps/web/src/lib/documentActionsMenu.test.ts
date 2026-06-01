import { describe, it, expect } from 'vitest';
import { buildMenuItems, type MenuItemId } from './documentActionsMenu.ts';

const ids = (items: { id: MenuItemId }[]) => items.map((i) => i.id);

describe('buildMenuItems', () => {
  it('shows HTML actions, separator, then comment actions for a non-uploader', () => {
    const items = buildMenuItems({ isUploader: false });
    expect(ids(items)).toEqual([
      'open-fullscreen',
      'download-html',
      'separator',
      'copy',
      'download',
    ]);
  });

  it('appends a separator and delete for an uploader', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(ids(items)).toEqual([
      'open-fullscreen',
      'download-html',
      'separator',
      'copy',
      'download',
      'separator',
      'delete',
    ]);
  });

  it('marks the delete item as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    const del = items.find((i) => i.id === 'delete');
    expect(del?.destructive).toBe(true);
  });

  it('does not mark non-destructive items as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    for (const id of ['open-fullscreen', 'download-html', 'copy', 'download'] as const) {
      expect(items.find((i) => i.id === id)?.destructive).toBeFalsy();
    }
  });

  it('labels every non-separator item with a string', () => {
    const items = buildMenuItems({ isUploader: true });
    for (const item of items) {
      if (item.id === 'separator') continue;
      expect(typeof item.label).toBe('string');
      expect(item.label!.length).toBeGreaterThan(0);
    }
  });
});
