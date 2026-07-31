import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MentionableUser } from '@polygonlabs/primer-api-types';
import { useMentionableUsers } from '../queries/users.ts';
import { reconcileMentions } from './reconcileMentions.ts';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Called with the final reconciled mention IDs whenever value changes. */
  onMentionsChange: (mentionIds: string[]) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  autoFocus?: boolean;
  /** Optional id for the underlying <textarea> (for label association). */
  id?: string;
  className?: string;
  /** IDs already selected (for edit forms — keeps existing mentions when the
   *  body already contains them). Used only on first render. */
  initialSelectedIds?: ReadonlyArray<string>;
}

const POPOVER_MAX = 6;

export function MentionTextarea({
  value,
  onChange,
  onMentionsChange,
  placeholder,
  rows = 2,
  maxLength = 5000,
  autoFocus = false,
  id,
  className,
  initialSelectedIds,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const usersQ = useMentionableUsers();
  const users: MentionableUser[] = usersQ.data ?? [];
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds ?? []));

  // Imperative focus instead of the DOM autofocus attribute: preventScroll
  // keeps the surrounding scroll containers (and a zoomed-in window) from
  // panning to the textarea when it mounts.
  useEffect(() => {
    if (autoFocus) taRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typeahead state.
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [dropdownPlacement, setDropdownPlacement] = useState<'below' | 'above'>('below');

  // Recompute reconciled mentions whenever body or selection changes.
  useEffect(() => {
    onMentionsChange(reconcileMentions(value, selected, users));
  }, [value, selected, users, onMentionsChange]);

  useEffect(() => {
    if (!trigger) return;
    const ta = taRef.current;
    if (!ta) return;
    // Use visualViewport when available so the keyboard's intruded height is
    // factored in; fall back to innerHeight on older UAs.
    const viewportH =
      typeof window !== 'undefined' && window.visualViewport
        ? window.visualViewport.height + window.visualViewport.offsetTop
        : window.innerHeight;
    const r = ta.getBoundingClientRect();
    const spaceBelow = viewportH - r.bottom;
    const spaceAbove = r.top;
    // Dropdown is max-h-44 ≈ 11rem ≈ 176px. Need ~180px to comfortably fit.
    setDropdownPlacement(spaceBelow >= 180 || spaceBelow >= spaceAbove ? 'below' : 'above');
  }, [trigger]);

  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return users
      .filter((u) => u.displayName.toLowerCase().includes(q))
      .slice(0, POPOVER_MAX);
  }, [trigger, users]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    onChange(next);
    updateTrigger(next, e.target.selectionStart ?? next.length);
  }

  function updateTrigger(text: string, caret: number) {
    // Walk left from caret to the nearest @ or whitespace.
    let i = caret - 1;
    while (i >= 0 && text[i] !== '@' && !/\s/.test(text[i])) i--;
    if (i >= 0 && text[i] === '@') {
      const query = text.slice(i + 1, caret);
      // Cap the query at 40 chars to avoid pathological cases.
      if (query.length <= 40) {
        setTrigger({ start: i, query });
        setHighlightIdx(0);
        return;
      }
    }
    setTrigger(null);
  }

  function pick(u: MentionableUser) {
    if (!trigger || !taRef.current) return;
    const before = value.slice(0, trigger.start);
    const after = value.slice(taRef.current.selectionStart ?? value.length);
    const inserted = `@${u.displayName} `;
    const nextBody = `${before}${inserted}${after}`;
    onChange(nextBody);
    setSelected((s) => new Set(s).add(u.id));
    setTrigger(null);
    // Restore caret after the inserted mention.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const pos = before.length + inserted.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!trigger || matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(matches[highlightIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTrigger(null);
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={taRef}
        id={id}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        // onMouseDown's preventDefault on popover items keeps the textarea focused;
        // the 120ms grace is belt-and-braces for keyboard/touch dismissals.
        onBlur={() => setTimeout(() => setTrigger(null), 120)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        className={className ?? 'block w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs'}
      />
      {trigger && matches.length > 0 && (
        <ul
          role="listbox"
          className={`absolute left-0 right-0 z-20 max-h-44 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-md ${
            dropdownPlacement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {matches.map((u, idx) => (
            <li
              key={u.id}
              role="option"
              aria-selected={idx === highlightIdx}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
              className={`cursor-pointer px-3 py-1.5 text-xs ${
                idx === highlightIdx ? 'bg-yellow-50 dark:bg-amber-900/20' : ''
              }`}
            >
              <span className="font-medium text-neutral-800 dark:text-neutral-200">{u.displayName}</span>
              <span className="ml-2 text-neutral-500">{u.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
