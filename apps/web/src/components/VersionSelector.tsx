import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VersionSummaryDTO } from '@primer/shared';

interface Props {
  docId: string;
  versions: VersionSummaryDTO[];
  currentVersionNumber: number;
  isViewingLatest: boolean;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export function VersionSelector({
  docId,
  versions,
  currentVersionNumber,
  isViewingLatest,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const latest = versions[0];
  const latestNumber = latest?.versionNumber ?? currentVersionNumber;

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const label = isViewingLatest
    ? `v${currentVersionNumber} · latest`
    : `v${currentVersionNumber} of ${latestNumber}`;

  function pick(v: VersionSummaryDTO) {
    setOpen(false);
    if (v.versionNumber === latestNumber) {
      navigate(`/d/${docId}`);
    } else {
      navigate(`/d/${docId}/v/${v.versionNumber}`);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-10 mt-1 max-h-72 w-72 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-md"
        >
          {versions.map((v) => {
            const isCurrent = v.versionNumber === currentVersionNumber;
            const isLatest = v.versionNumber === latestNumber;
            return (
              <li
                key={v.id}
                role="option"
                aria-selected={isCurrent}
                onClick={() => pick(v)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800 ${isCurrent ? 'bg-yellow-50 dark:bg-amber-900/20' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-neutral-700 dark:text-neutral-300">v{v.versionNumber}</div>
                  <div className="truncate text-neutral-500">
                    {v.versionNote ? v.versionNote : <span className="italic text-neutral-400 dark:text-neutral-500">no note</span>}
                  </div>
                  <div className="text-[10px] text-neutral-400 dark:text-neutral-500">{relativeTime(v.createdAt)}</div>
                </div>
                {isLatest && (
                  <span className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white dark:bg-neutral-100 dark:text-neutral-900">
                    Latest
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
