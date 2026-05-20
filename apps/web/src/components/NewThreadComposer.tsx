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
      className="border-b border-yellow-200 bg-yellow-50 px-3 py-2 text-xs"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
        New comment
      </div>
      <div className="mb-2 border-l-2 border-yellow-300 pl-2 italic text-neutral-600">
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
