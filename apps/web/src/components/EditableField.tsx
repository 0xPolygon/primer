import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  value: string | null;
  placeholder: string;
  /** Whether the current user is allowed to edit. */
  canEdit: boolean;
  /** Render mode: single-line input vs. multi-line textarea. */
  multiline?: boolean;
  /** Tailwind classes for the display element. */
  displayClassName?: string;
  /** Max chars (applied to maxlength attribute and not enforced post-trim). */
  maxLength?: number;
  /** Saved when the user commits via Enter (input) / Cmd+Enter (textarea) / blur. */
  onSave: (next: string | null) => Promise<void> | void;
  /** Aria label for screen readers. */
  ariaLabel: string;
}

export function EditableField({
  value,
  placeholder,
  canEdit,
  multiline = false,
  displayClassName = '',
  maxLength,
  onSave,
  ariaLabel,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  async function commit() {
    const trimmed = draft.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    if (next === (value ?? null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(value ?? '');
    setError(null);
    setEditing(false);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter') {
      if (multiline && !(e.metaKey || e.ctrlKey)) return; // multiline: only Cmd/Ctrl+Enter saves
      e.preventDefault();
      void commit();
    }
  }

  if (!editing) {
    const isEmpty = !value || value.length === 0;
    return (
      <div
        className={`group inline-flex items-center gap-1.5 ${canEdit ? 'cursor-pointer' : ''}`}
        onClick={() => canEdit && setEditing(true)}
      >
        <span className={`${displayClassName} ${isEmpty && canEdit ? 'italic text-neutral-400 dark:text-neutral-500' : ''}`}>
          {isEmpty ? (canEdit ? placeholder : '') : value}
        </span>
        {canEdit && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="opacity-0 transition-opacity group-hover:opacity-60"
            aria-hidden="true"
          >
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        )}
      </div>
    );
  }

  const Input = multiline ? 'textarea' : 'input';

  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={inputRef as React.Ref<HTMLInputElement & HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={handleKey}
        onBlur={() => { void commit(); }}
        maxLength={maxLength}
        aria-label={ariaLabel}
        rows={multiline ? 3 : undefined}
        className={`block w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm ${displayClassName}`}
        disabled={saving}
      />
      {error && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </div>
  );
}
