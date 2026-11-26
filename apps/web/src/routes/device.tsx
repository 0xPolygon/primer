import { useState, type FormEvent } from 'react';
import { useMe } from '../queries/me.ts';
import {
  DevicePendingError,
  isValidUserCode,
  useApproveDevice,
  useDenyDevice,
  useDevicePending,
} from '../queries/device.ts';
import { t } from '../i18n/index.ts';

// Per spec D13 (phishing mitigation): we intentionally do NOT read `?code=`
// from the URL — even though the verification_uri_complete the API issues
// includes one. Pre-filling the code would defeat the out-of-band confirmation
// the device flow exists to provide. The user MUST read the code from their
// terminal and type it here so a victim of a social-engineering attack (e.g.
// being sent a link with someone else's pending code) has a chance to notice
// the mismatch.

type Step =
  | { kind: 'input' }
  | { kind: 'confirm'; userCode: string }
  | { kind: 'result'; outcome: 'approved' | 'denied' };

/**
 * Render a short relative-time string for an ISO timestamp, like "2 minutes ago".
 * Inlined to avoid adding a dependency for one helper.
 */
function relativeTimeFrom(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 5) return t('device.justNow');
  if (seconds < 60) return t('device.secondsAgo', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t(minutes === 1 ? 'device.minuteAgo' : 'device.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(hours === 1 ? 'device.hourAgo' : 'device.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t(days === 1 ? 'device.dayAgo' : 'device.daysAgo', { count: days });
}

/** Normalise input: uppercase and auto-insert a dash after 4 chars (UX nicety). */
function normalizeUserCode(raw: string): string {
  const upper = raw.toUpperCase();
  // Strip everything not in the server alphabet (excludes 0/1/O/I) or dash,
  // then re-insert a single dash after position 4.
  const cleaned = upper.replace(/[^A-HJ-NP-Z2-9-]/g, '');
  const noDash = cleaned.replace(/-/g, '');
  if (noDash.length <= 4) return noDash;
  return `${noDash.slice(0, 4)}-${noDash.slice(4, 8)}`;
}

export function DevicePage() {
  const [step, setStep] = useState<Step>({ kind: 'input' });

  return (
    <div className="mx-auto max-w-md space-y-5">
      <h1 className="text-2xl font-semibold">{t('device.title')}</h1>
      {step.kind === 'input' && (
        <InputStep
          onSubmit={(userCode) => setStep({ kind: 'confirm', userCode })}
        />
      )}
      {step.kind === 'confirm' && (
        <ConfirmStep
          userCode={step.userCode}
          onBack={() => setStep({ kind: 'input' })}
          onApproved={() => setStep({ kind: 'result', outcome: 'approved' })}
          onDenied={() => setStep({ kind: 'result', outcome: 'denied' })}
        />
      )}
      {step.kind === 'result' && <ResultStep outcome={step.outcome} />}
    </div>
  );
}

function InputStep({ onSubmit }: { onSubmit: (userCode: string) => void }) {
  // Default is empty — see file-top comment re: spec D13. We never read
  // useSearchParams or window.location.search here.
  const [value, setValue] = useState('');
  const canSubmit = isValidUserCode(value);

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(value);
  }

  return (
    <form onSubmit={onFormSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">{t('device.verificationCode')}</span>
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="XXXX-XXXX"
          value={value}
          onChange={(e) => setValue(normalizeUserCode(e.target.value))}
          maxLength={9}
          className="block w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-lg tracking-widest dark:border-neutral-700"
        />
        <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
          {t('device.enterCode')}
        </span>
      </label>
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {t('device.continue')}
        </button>
      </div>
    </form>
  );
}

interface ConfirmStepProps {
  userCode: string;
  onBack: () => void;
  onApproved: () => void;
  onDenied: () => void;
}

function ConfirmStep({ userCode, onBack, onApproved, onDenied }: ConfirmStepProps) {
  const me = useMe();
  const pending = useDevicePending(userCode);
  const approve = useApproveDevice();
  const deny = useDenyDevice();

  if (pending.isLoading) {
    return <div className="text-sm text-neutral-500">{t('device.loadingRequest')}</div>;
  }

  if (pending.error) {
    const err = pending.error;
    const status = err instanceof DevicePendingError ? err.status : 0;
    if (status === 404) {
      return (
        <ErrorPanel
          title={t('device.unknownCode')}
          message={t('device.unknownCodeHint')}
          onBack={onBack}
        />
      );
    }
    if (status === 410) {
      return (
        <ErrorPanel
          title={t('device.expired')}
          message={t('device.expiredHint')}
          onBack={onBack}
        />
      );
    }
    return (
      <ErrorPanel
        title={t('device.loadFailed')}
        message={(err as Error).message}
        onBack={onBack}
      />
    );
  }

  if (!pending.data) return null;

  const data = pending.data;
  const ip = data.requesterIp ?? t('device.unknownIp');
  const busy = approve.isPending || deny.isPending;

  async function onApprove() {
    try {
      await approve.mutateAsync(userCode);
      onApproved();
    } catch {
      // Surface in UI below via approve.error.
    }
  }

  async function onDeny() {
    try {
      await deny.mutateAsync(userCode);
      onDenied();
    } catch {
      // Surface in UI below via deny.error.
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm">
        {t('device.approveFor')}{' '}
        <strong className="font-semibold">{me.data?.email ?? '…'}</strong>?
      </p>

      <div className="rounded border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
          {t('device.requestDetails')}
        </div>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-neutral-500 dark:text-neutral-400">{t('device.clientLabel')}</dt>
            <dd className="font-mono text-neutral-800 dark:text-neutral-200">
              {data.clientLabel ?? <span className="italic text-neutral-500">{t('device.none')}</span>}
            </dd>
            <dd className="text-xs italic text-neutral-500 dark:text-neutral-400">
              {t('device.claimedNotVerified')}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500 dark:text-neutral-400">{t('device.requesterIp')}</dt>
            <dd className="font-mono text-neutral-800 dark:text-neutral-200">{ip}</dd>
          </div>
          <div>
            <dt className="text-neutral-500 dark:text-neutral-400">{t('device.started')}</dt>
            <dd className="text-neutral-800 dark:text-neutral-200">
              {relativeTimeFrom(data.createdAt)}
            </dd>
          </div>
        </dl>
      </div>

      {(approve.error || deny.error) && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {((approve.error ?? deny.error) as Error).message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDeny}
          disabled={busy}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {deny.isPending ? t('device.denying') : t('device.deny')}
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {approve.isPending ? t('device.approving') : t('device.approve')}
        </button>
      </div>
    </div>
  );
}

function ErrorPanel({
  title,
  message,
  onBack,
}: {
  title: string;
  message: string;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        <div className="font-medium">{title}</div>
        <div className="mt-1">{message}</div>
      </div>
      <button
        type="button"
        onClick={onBack}
        className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {t('device.back')}
      </button>
    </div>
  );
}

function ResultStep({ outcome }: { outcome: 'approved' | 'denied' }) {
  if (outcome === 'approved') {
    return (
      <div className="rounded border border-neutral-200 bg-neutral-50 px-4 py-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <div className="font-medium text-neutral-900 dark:text-neutral-100">{t('device.accessGranted')}</div>
        <div className="mt-1 text-neutral-600 dark:text-neutral-400">
          {t('device.returnToTerminal')}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded border border-neutral-200 bg-neutral-50 px-4 py-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="font-medium text-neutral-900 dark:text-neutral-100">{t('device.accessDenied')}</div>
    </div>
  );
}
