import { describe, it, expect } from 'vitest';
import { buildMenuItems, type MenuItemId } from './documentActionsMenu.ts';

const ids = (items: { id: MenuItemId }[]) => items.map((i) => i.id);

describe('buildMenuItems', () => {
  it('shows Copy and Download for a non-uploader', () => {
    const items = buildMenuItems({ isUploader: false });
    expect(ids(items)).toEqual(['copy', 'download']);
  });

  it('shows Copy, Download, separator, Delete for an uploader', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(ids(items)).toEqual(['copy', 'download', 'separator', 'delete']);
  });

  it('marks the delete item as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    const del = items.find((i) => i.id === 'delete');
    expect(del?.destructive).toBe(true);
  });

  it('does not mark copy/download as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(items.find((i) => i.id === 'copy')?.destructive).toBeFalsy();
    expect(items.find((i) => i.id === 'download')?.destructive).toBeFalsy();
  });
});
