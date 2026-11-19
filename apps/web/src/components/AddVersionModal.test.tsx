// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }));
vi.mock('../queries/library.ts', () => ({
  useLibraryQuery: () => ({ data: { documents: [{ id: 'd1', title: 'Plan', ownership: 'mine', updatedAt: new Date().toISOString() }] } }),
}));
vi.mock('../queries/versions.ts', () => ({
  useAddVersion: () => ({
    isPending: false,
    mutateAsync: async () => ({
      url: '/d/d1',
      reconciliation: {
        docVersion: 9,
        outcomes: [
          { index: 0, target: { tabId: 'main', blockId: 'a' }, status: 'suggested', suggestionId: 's1' },
          { index: 1, target: { tabId: 'main', blockId: 'b' }, status: 'unchanged' },
        ],
      },
    }),
  }),
}));

describe('AddVersionModal', () => {
  it('a republish that only suggests shows its suggestions instead of opening a version', async () => {
    const { AddVersionModal } = await import('./AddVersionModal.tsx');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(MemoryRouter, null, createElement(AddVersionModal, { open: true, preselectedDocId: 'd1', preselectedDocTitle: 'Plan', onClose: () => undefined }))),
    );
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['# Plan\n'], 'plan.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    const add = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add version')!;
    await act(async () => add.click());
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector('[data-republish-suggested]')!.textContent).toContain('Suggested: 1. Conflicts: 0. Unchanged: 1.');
    const openDoc = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open the document')!;
    await act(async () => openDoc.click());
    expect(navigate).toHaveBeenCalledWith('/d/d1');
    await act(async () => root.unmount());
  });
});
