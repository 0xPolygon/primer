import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collaborator } from '@primer/shared/api';
import { useDocument } from '../queries/documents.ts';
import {
  useCollaborators,
  useUserSearch,
  useAddCollaborator,
  useUpdateCollaboratorRole,
  useRemoveCollaborator,
  useSetVisibility,
} from '../queries/collaborators.ts';
import { roleOptions } from '../lib/share.ts';

type CollaboratorRole = 'commenter' | 'editor';

interface Props {
  open: boolean;
  docId: string;
  onClose: () => void;
}

const DEBOUNCE_MS = 200;

export function ShareModal({ open, docId, onClose }: Props) {
  const doc = useDocument(docId);
  const collabs = useCollaborators(docId);
  const visibility = doc.data?.document.visibility ?? 'org';

  const setVisibility = useSetVisibility(docId);
  const addCollab = useAddCollaborator(docId);
  const updateRole = useUpdateCollaboratorRole(docId);
  const removeCollab = useRemoveCollaborator(docId);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<CollaboratorRole>('editor');
  const [inlineError, setInlineError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Reset when opening.
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setSearchInput('');
      setDebouncedQ('');
      setPendingUserId(null);
      setPendingRole('editor');
      setInlineError(null);
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Debounce search input.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput, open]);

  const search = useUserSearch(debouncedQ, docId);
  const options = useMemo(() => roleOptions(visibility), [visibility]);

  // If the current selected role becomes disabled (e.g., commenter after flipping to org),
  // reset to editor.
  useEffect(() => {
    const opt = options.find((o) => o.value === pendingRole);
    if (opt?.disabled) setPendingRole('editor');
  }, [options, pendingRole]);

  async function onToggleVisibility(next: 'org' | 'private') {
    setInlineError(null);
    try {
      await setVisibility.mutateAsync(next);
    } catch (e) {
      setInlineError(`Could not change visibility: ${(e as Error).message}`);
    }
  }

  async function onAdd() {
    if (!pendingUserId) return;
    setInlineError(null);
    try {
      await addCollab.mutateAsync({ userId: pendingUserId, role: pendingRole });
      setSearchInput('');
      setDebouncedQ('');
      setPendingUserId(null);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('collaborator_exists')) setInlineError('Already a collaborator.');
      else if (msg.includes('invalid_role_for_visibility')) setInlineError('Commenter is only meaningful under private visibility.');
      else if (msg.includes('owner_not_collaborator')) setInlineError('The doc owner is already the doc owner.');
      else setInlineError(`Could not add: ${msg}`);
    }
  }

  async function onChangeRole(row: Collaborator, next: CollaboratorRole) {
    setInlineError(null);
    try {
      await updateRole.mutateAsync({ userId: row.userId, role: next });
    } catch (e) {
      setInlineError(`Could not change role: ${(e as Error).message}`);
    }
  }

  async function onRemove(row: Collaborator) {
    setInlineError(null);
    try {
      await removeCollab.mutateAsync(row.userId);
    } catch (e) {
      setInlineError(`Could not remove: ${(e as Error).message}`);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-modal-title"
        className="w-full max-w-lg rounded-lg bg-white shadow-lg dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 id="share-modal-title" className="text-base font-semibold">
            Share "{doc.data?.document.title ?? '…'}"
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </header>

        <div className="space-y-5 px-4 py-4">
          {/* Visibility */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Visibility</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onToggleVisibility('org')}
                className={
                  visibility === 'org'
                    ? 'rounded border border-purple-600 bg-purple-600 px-3 py-1.5 text-sm text-white'
                    : 'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                }
              >
                Everyone at Polygon
              </button>
              <button
                type="button"
                onClick={() => onToggleVisibility('private')}
                className={
                  visibility === 'private'
                    ? 'rounded border border-purple-600 bg-purple-600 px-3 py-1.5 text-sm text-white'
                    : 'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800'
                }
              >
                Private
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              {visibility === 'org'
                ? 'Anyone at Polygon can read and comment. Only owner and editors can make changes.'
                : 'Only you and the collaborators listed below can access this document.'}
            </p>
          </section>

          {/* Add collaborator */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Add collaborator</h3>
            <div className="space-y-2">
              <input
                type="text"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setPendingUserId(null);
                }}
                placeholder="Search by name…"
                className="w-full rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
              />
              {debouncedQ.length > 0 && search.data && search.data.length > 0 && (
                <ul className="max-h-48 overflow-y-auto rounded border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                  {search.data.map((u) => (
                    <li
                      key={u.id}
                      className={
                        pendingUserId === u.id
                          ? 'cursor-pointer bg-purple-100 px-3 py-2 text-sm dark:bg-purple-900/50'
                          : 'cursor-pointer px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800'
                      }
                      onClick={() => {
                        setPendingUserId(u.id);
                        setSearchInput(u.displayName);
                      }}
                    >
                      <div>{u.displayName}</div>
                      <div className="text-xs text-neutral-500">{u.email}</div>
                    </li>
                  ))}
                </ul>
              )}
              {debouncedQ.length > 0 && search.data && search.data.length === 0 && (
                <p className="text-xs text-neutral-500">No matches.</p>
              )}
              {pendingUserId && (
                <div className="flex items-center gap-2">
                  <select
                    value={pendingRole}
                    onChange={(e) => setPendingRole(e.target.value as CollaboratorRole)}
                    className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value} disabled={o.disabled} title={o.tooltip}>
                        {o.label}
                        {o.disabled ? ' (private only)' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={onAdd}
                    disabled={addCollab.isPending}
                    className="rounded border border-neutral-900 bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                  >
                    {addCollab.isPending ? 'Adding…' : 'Add'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* Current collaborators */}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Collaborators</h3>
            {collabs.data && collabs.data.length === 0 && (
              <p className="text-xs text-neutral-500">No collaborators yet.</p>
            )}
            {collabs.data && collabs.data.length > 0 && (
              <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {collabs.data.map((c) => (
                  <li key={c.userId} className="flex items-center justify-between py-2">
                    <div>
                      <div className="text-sm">{c.displayName}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={c.role}
                        onChange={(e) => onChangeRole(c, e.target.value as CollaboratorRole)}
                        className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                      >
                        {options.map((o) => (
                          <option
                            key={o.value}
                            value={o.value}
                            disabled={o.disabled && o.value !== c.role}
                            title={o.tooltip}
                          >
                            {o.label}
                            {o.disabled && o.value !== c.role ? ' (private only)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove ${c.displayName}`}
                        onClick={() => onRemove(c)}
                        className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {inlineError && (
            <div role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/50 dark:text-red-200">
              {inlineError}
            </div>
          )}
        </div>

        <footer className="flex justify-end border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
