import { useEffect, useMemo, useState } from 'react';
import type { AnchorData, ThreadDTO } from '@primer/shared';
import { useThreadsQuery } from '../queries/threads.ts';
import { ThreadCard } from './ThreadCard.tsx';
import { NewThreadComposer } from './NewThreadComposer.tsx';

interface PendingAnchor {
  anchor: AnchorData;
}

interface Props {
  versionId: string;
  currentUserId: string;
  pending: PendingAnchor | null;
  onCancelPending: () => void;
  onSubmitPending: (body: string) => Promise<void>;
  onHighlight: (anchorId: string) => void;
  /** anchorId → top-of-rect y in iframe viewport (from anchor_positions). */
  positionsByAnchorId?: Map<string, { y: number; drifted: boolean }>;
}

const COLLAPSED_KEY = 'primer.sidebar.collapsed';

export function CommentSidebar({
  versionId,
  currentUserId,
  pending,
  onCancelPending,
  onSubmitPending,
  onHighlight,
  positionsByAnchorId,
}: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  const [hideResolved, setHideResolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const query = useThreadsQuery(versionId);
  const threads = query.data?.data.threads ?? [];

  const sortedThreads = useMemo<ThreadDTO[]>(() => {
    if (!positionsByAnchorId || positionsByAnchorId.size === 0) {
      return [...threads].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }
    return [...threads].sort((a, b) => {
      const pa = positionsByAnchorId.get(a.id);
      const pb = positionsByAnchorId.get(b.id);
      if (pa?.drifted && !pb?.drifted) return 1;
      if (!pa?.drifted && pb?.drifted) return -1;
      const ya = pa?.y ?? Number.POSITIVE_INFINITY;
      const yb = pb?.y ?? Number.POSITIVE_INFINITY;
      if (ya !== yb) return ya - yb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [threads, positionsByAnchorId]);

  const visible = hideResolved
    ? sortedThreads.filter((t) => t.resolvedAt === null)
    : sortedThreads;
  const activeCount = threads.filter((t) => t.resolvedAt === null).length;

  if (collapsed) {
    return (
      <div className="flex h-full w-9 flex-col items-center gap-2 border-l border-neutral-200 bg-white py-2">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 items-center justify-center rounded border border-neutral-300 bg-white text-xs text-neutral-600 hover:bg-neutral-50"
        >
          ›
        </button>
        <span className="rounded-full border border-amber-300 bg-amber-100 px-2 text-[9px] font-semibold text-neutral-700">
          {activeCount}
        </span>
        <div className="flex w-full flex-1 flex-col items-center gap-1 pt-2">
          {sortedThreads.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.anchor.type === 'text-range' ? t.anchor.selectorText : t.anchor.path}
              onClick={() => {
                setCollapsed(false);
                onHighlight(t.id);
              }}
              className={`h-1.5 w-[18px] rounded-sm ${
                t.resolvedAt !== null ? 'bg-neutral-300' : 'bg-yellow-300'
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[300px] flex-col border-l border-neutral-200 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 text-xs text-neutral-600">
        <span className="font-semibold text-neutral-900">
          {threads.length} thread{threads.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer select-none items-center gap-1">
            <input
              type="checkbox"
              checked={hideResolved}
              onChange={(e) => setHideResolved(e.target.checked)}
              className="h-3 w-3"
            />
            Hide resolved
          </label>
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            className="text-neutral-500 hover:text-neutral-900"
          >
            ›
          </button>
        </div>
      </header>

      {pending && (
        <NewThreadComposer
          anchor={pending.anchor}
          submitting={submitting}
          onCancel={onCancelPending}
          onSubmit={async (body) => {
            setSubmitting(true);
            try {
              await onSubmitPending(body);
            } finally {
              setSubmitting(false);
            }
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {visible.map((t) => {
          const pos = positionsByAnchorId?.get(t.id);
          return (
            <ThreadCard
              key={t.id}
              versionId={versionId}
              thread={t}
              drifted={pos?.drifted ?? false}
              currentUserId={currentUserId}
              onHighlight={onHighlight}
            />
          );
        })}
        {visible.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500">
            {threads.length === 0 ? 'No comments yet.' : 'No active threads (all resolved).'}
          </div>
        )}
      </div>
    </aside>
  );
}
