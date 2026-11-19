import { useEffect } from 'react';
import { AUDIENCE_MEANING, type GrantEnvelope } from '../lib/eventsGrant.ts';
import { t } from '../i18n';

interface Props {
  envelope: GrantEnvelope;
  documentTitle: string;
  onAllow: () => void;
  onDeny: () => void;
}

/**
 * First-submission grant prompt (issue #78, security requirement 6) —
 * Primer-owned chrome, rendered in the PARENT page's DOM as a sibling of
 * the artifact iframe. The artifact cannot draw over it (the overlay sits
 * above the iframe in the parent's stacking context), cannot dispatch
 * events into it (the iframe's opaque origin has no path to the parent DOM
 * — only the companion MessagePort, which carries data, never UI events),
 * and cannot synthesize acceptance (nothing in the companion protocol
 * touches this component; only a real click on these buttons resolves it).
 *
 * This is the DISCLOSURE MOMENT: it shows the envelope — how many events,
 * which namespaces, and each audience with its plain-language meaning (who
 * will see the data) — never the payload bytes, which are opaque by design.
 */
export function EventsGrantPrompt({ envelope, documentTitle, onAllow, onDeny }: Props) {
  // ESC = deny: closing the prompt without an explicit Allow must never
  // grant anything.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDeny();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDeny]);

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="events-grant-title"
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900">
        <h2 id="events-grant-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t('eventsGrantPrompt.title')}
        </h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {t('eventsGrantPrompt.intro')} <span className="font-medium">“{documentTitle}”</span>{' '}
          {t('eventsGrantPrompt.wantsToSubmit')}{' '}
          <span className="font-medium">
            {envelope.eventCount} {envelope.eventCount === 1 ? t('eventsGrantPrompt.eventOne') : t('eventsGrantPrompt.eventMany')}
          </span>{' '}
          {envelope.namespaces.length === 1 ? t('eventsGrantPrompt.inYourNameOne') : t('eventsGrantPrompt.inYourNameMany')}{' '}
          {envelope.namespaces.map((ns, i) => (
            <span key={ns}>
              {i > 0 && ', '}
              <code className="rounded bg-neutral-100 px-1 text-xs dark:bg-neutral-800">{ns}</code>
            </span>
          ))}
          {t('eventsGrantPrompt.whoWillSee')}
        </p>
        <ul className="mt-3 space-y-2">
          {envelope.audiences.map((audience) => (
            <li key={audience} className="flex gap-2 text-sm">
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {audience}
              </span>
              <span className="text-neutral-700 dark:text-neutral-300">{AUDIENCE_MEANING[audience]}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-neutral-500">
          {t('eventsGrantPrompt.scopeNote')}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onDeny}
            className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {t('eventsGrantPrompt.deny')}
          </button>
          <button
            type="button"
            onClick={onAllow}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {t('eventsGrantPrompt.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
