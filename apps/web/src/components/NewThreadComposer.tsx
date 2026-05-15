import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AnchorData } from '@primer/shared';

interface Props {
  anchor: AnchorData;
  submitting: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

function anchorPreview(a: AnchorData): string {
  if (a.type === 'text-range') {
    return `"…${a.selectorText.slice(0, 80)}${a.selectorText.length > 80 ? '…' : ''}"`;
  }
  return a.path;
}

export function NewThreadComposer({ anchor, submitting, onSubmit, onCancel }: Props) {
  const [body, setBody] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (body.trim().length === 0) return;
    onSubmit(body.trim());
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (body.trim().length > 0) onSubmit(body.trim());
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-b border-yellow-200 bg-yellow-50 px-3 py-2 text-xs"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
        New comment
      </div>
      <div className="mb-2 border-l-2 border-yellow-300 pl-2 italic text-neutral-600">
        {anchorPreview(anchor)}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        maxLength={5000}
        placeholder="Write a comment…"
        className="block w-full rounded border border-neutral-300 px-2 py-1 text-xs"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || body.trim().length === 0}
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Comment'}
        </button>
      </div>
    </form>
  );
}
