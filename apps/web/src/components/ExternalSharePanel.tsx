import { useEffect, useRef, useState } from 'react';
import {
  useExternalShare, useCreateExternalShare, useRevokeExternalShare,
  useAddExternalRecipient, useRevokeExternalRecipient, usePublishExternalShare,
} from '../queries/externalShare.ts';
import { useVersionsQuery } from '../queries/versions.ts';
import { copyText } from '../lib/clipboardCopy.ts';
import { ViewActivityModal } from './ViewActivityModal.tsx';
import { CopyIcon, CheckIcon } from './icons.tsx';

interface Props {
  docId: string;
}

function PlusIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function ExternalSharePanel({ docId }: Props) {
  const share = useExternalShare(docId, true);
  const versionsQuery = useVersionsQuery(docId);
  const create = useCreateExternalShare(docId);
  const revokeShare = useRevokeExternalShare(docId);
  const addRecipient = useAddExternalRecipient(docId);
  const revokeRecipient = useRevokeExternalRecipient(docId);
  const publish = usePublishExternalShare(docId);
  const [email, setEmail] = useState('');
  const [publishTarget, setPublishTarget] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
  }, []);

  async function copyShareLink(url: string) {
    const result = await copyText(url);
    if (result === 'failed') return;
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 1500);
  }

  if (share.isLoading || share.data === null) return null; // 403 → not a manager
  const data = share.data;

  // versions sorted newest-first by the API; [0] is the latest
  const versions = versionsQuery.data?.versions ?? [];
  const latestVersionNumber = versions[0]?.versionNumber ?? null;

  return (
    <section className="mt-6 border-t border-neutral-200 dark:border-neutral-800 pt-4">
      <h3 className="text-sm font-semibold mb-1">External sharing</h3>
      <p className="text-xs text-neutral-500 mb-3">
        Share a published version with people outside Polygon. They verify with an emailed code.
      </p>

      {data && !data.emailEnabled && (
        <p className="mb-3 rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          Email delivery is not configured on this server — external recipients cannot receive
          verification codes, so external sharing is currently non-functional.
        </p>
      )}

      {!data?.share && (
        <button
          type="button"
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          {create.isPending ? 'Creating…' : 'Enable external sharing'}
        </button>
      )}

      {data?.share && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={`${window.location.origin}/share/${data.share.shareToken}`}
              className="flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-2 py-1 text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              title={copied ? 'Copied' : 'Copy link'}
              aria-label={copied ? 'Copied' : 'Copy link'}
              className={`rounded border border-neutral-300 dark:border-neutral-700 p-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 ${copied ? 'text-green-600 dark:text-green-400' : ''}`}
              onClick={() => void copyShareLink(`${window.location.origin}/share/${data.share!.shareToken}`)}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>

          <div className="text-xs">
            {data.share.publishedVersionNumber === null ? (
              <p className="text-amber-600 font-medium">
                Nothing is published yet — external recipients can't see anything until you publish a version.
              </p>
            ) : (
              <p className="text-neutral-500">
                Externals see <strong>v{data.share.publishedVersionNumber}</strong>
                {latestVersionNumber !== null && data.share.publishedVersionNumber !== latestVersionNumber && (
                  <span className="text-amber-600"> — latest internal is v{latestVersionNumber}</span>
                )}
                . New uploads change nothing externally until re-published.
              </p>
            )}
            <div className="mt-2 flex items-center gap-2">
              <select
                value={publishTarget}
                onChange={(e) => setPublishTarget(e.target.value)}
                className="rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs"
              >
                <option value="">Choose version…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>v{v.versionNumber}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!publishTarget || publish.isPending}
                onClick={() => { publish.mutate({ versionId: publishTarget }); setPublishTarget(''); }}
                className="rounded bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 px-3 py-1 text-xs font-medium disabled:opacity-40"
              >
                Publish to external
              </button>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              addRecipient.mutate({ email: email.trim() }, { onSuccess: () => setEmail('') });
            }}
            className="flex items-center gap-2"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="client@company.com"
              className="flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-xs"
            />
            <button
              type="submit"
              disabled={addRecipient.isPending}
              title="Add recipient"
              aria-label="Add recipient"
              className="rounded border border-neutral-300 dark:border-neutral-700 p-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-40"
            >
              <PlusIcon />
            </button>
          </form>
          {addRecipient.isError && (
            <p className="text-xs text-red-600">{(addRecipient.error as Error).message === 'recipient_exists' ? 'That email already has access.' : 'Could not add recipient.'}</p>
          )}

          <ul className="space-y-1">
            {data.recipients.filter((r) => r.revokedAt === null).map((r) => (
              <li key={r.id} className="flex items-center justify-between text-xs">
                <span>
                  {r.email}
                  <span className="text-neutral-400 ml-2">
                    {r.firstViewedAt === null
                      ? 'never viewed'
                      : `${r.viewCount} view${r.viewCount === 1 ? '' : 's'}, last ${new Date(r.lastViewedAt!).toLocaleDateString()}`}
                    {' · expires '}{new Date(r.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => revokeRecipient.mutate({ recipientId: r.id })}
                  className="text-red-600 underline"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setActivityOpen(true)}
              className="text-xs text-neutral-600 dark:text-neutral-300 underline"
            >
              View activity
            </button>
            {!confirmRevoke ? (
              <button type="button" onClick={() => setConfirmRevoke(true)} className="text-xs text-red-600 underline">
                Revoke all external access
              </button>
            ) : (
              <div className="flex items-center gap-3 text-xs">
                <span className="text-red-600">Ends all recipient access immediately. Sure?</span>
                <button type="button" onClick={() => { revokeShare.mutate(); setConfirmRevoke(false); }} className="text-red-600 font-semibold underline">
                  Yes, revoke
                </button>
                <button type="button" onClick={() => setConfirmRevoke(false)} className="underline">Cancel</button>
              </div>
            )}
          </div>

          <ViewActivityModal open={activityOpen} docId={docId} onClose={() => setActivityOpen(false)} />
        </div>
      )}
    </section>
  );
}
