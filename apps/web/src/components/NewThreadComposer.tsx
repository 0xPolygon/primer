import { useState, type FormEvent } from 'react';
import type { AnchorData } from '@primer/shared';
import { MentionTextarea } from './MentionTextarea.tsx';

interface Props {
  anchor: AnchorData;
  submitting: boolean;
  onSubmit: (body: string, mentions: string[]) => void;
  onCancel: () => void;
}

function anchorPreview(a: AnchorData): string {
  if (a.type === 'text-range') {
    return `"…${a.selectorText.slice(0, 80)}${a.selectorText.length > 80 ? '…' : ''}"`;
  }
  const inner = a.innerText;
  if (inner && inner.length > 0) {
    return `"${inner.slice(0, 80)}${inner.length > 80 ? '…' : ''}"`;
  }
  return a.path;
}

export function NewThreadComposer({ anchor, submitting, onSubmit, onCancel }: Props) {
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (body.trim().length === 0) return;
    onSubmit(body.trim(), mentions);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-b border-yellow-200 dark:border-amber-800 bg-yellow-50 dark:bg-amber-900/20 px-3 py-2 text-xs"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        New comment
      </div>
      <div className="mb-2 border-l-2 border-yellow-300 dark:border-amber-700 pl-2 italic text-neutral-600 dark:text-neutral-400">
        {anchorPreview(anchor)}
      </div>
      <MentionTextarea
        value={body}
        onChange={setBody}
        onMentionsChange={setMentions}
        placeholder="Write a comment…"
        rows={3}
        autoFocus
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || body.trim().length === 0}
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {submitting ? 'Saving…' : 'Comment'}
        </button>
      </div>
    </form>
  );
}
