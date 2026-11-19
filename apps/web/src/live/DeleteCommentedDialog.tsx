import type { HeldDelete } from './commentDeleteGuard.ts';

/** Asks before a change removes commented text; the threads stay open,
 *  flagged "Text removed". */
export function DeleteCommentedDialog({ held, onClose }: { held: HeldDelete; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="delete-commented-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
        <h2 id="delete-commented-title" className="text-sm font-semibold">Delete commented text?</h2>
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
          This removes text that open comments point at. The comments stay open, marked "Text removed".
        </p>
        <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-5 text-xs">
          {held.quotes.map((quote, i) => (
            <li key={i}>“{quote}”</li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-7 rounded border border-neutral-300 px-3 text-xs dark:border-neutral-700">
            Keep text
          </button>
          <button
            type="button"
            onClick={() => {
              held.confirm();
              onClose();
            }}
            className="h-7 rounded bg-red-600 px-3 text-xs text-white hover:bg-red-700"
          >
            Delete anyway
          </button>
        </div>
      </div>
    </div>
  );
}
