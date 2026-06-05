import type { ApiTokenSummary } from '@primer/shared/api';
import { useApiTokens, useRevokeToken } from '../queries/tokens.ts';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatLastUsed(iso: string | null): string {
  return iso ? formatDateTime(iso) : 'Never';
}

function formatExpires(iso: string | null): string {
  return iso ? formatDateTime(iso) : 'Never';
}

interface TokenRowProps {
  token: ApiTokenSummary;
  onRevoke: (token: ApiTokenSummary) => void;
  revoking: boolean;
}

function TokenRow({ token, onRevoke, revoking }: TokenRowProps) {
  const isRevoked = token.revokedAt !== null;
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-neutral-900 dark:text-neutral-100">
              {token.name}
            </span>
            {isRevoked ? (
              <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                Revoked {formatDateTime(token.revokedAt)}
              </span>
            ) : (
              <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-900/40 dark:text-green-300">
                Active
              </span>
            )}
          </div>
          <div className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
            primer_pat_{token.tokenPrefix}…
          </div>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400 sm:grid-cols-3">
            <div>
              <dt className="text-neutral-500 dark:text-neutral-500">Created</dt>
              <dd>{formatDateTime(token.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-500">Last used</dt>
              <dd>{formatLastUsed(token.lastUsedAt)}</dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-500">Expires</dt>
              <dd>{formatExpires(token.expiresAt)}</dd>
            </div>
          </dl>
        </div>
        {!isRevoked && (
          <button
            type="button"
            disabled={revoking}
            onClick={() => onRevoke(token)}
            className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            {revoking ? 'Revoking…' : 'Revoke'}
          </button>
        )}
      </div>
    </div>
  );
}

export function TokenSettingsPage() {
  const q = useApiTokens();
  const revoke = useRevokeToken();

  function onRevoke(token: ApiTokenSummary) {
    const confirmed = window.confirm(
      `Revoke token "${token.name}"? Any tool using it will lose access immediately.`
    );
    if (!confirmed) return;
    revoke.mutate(token.id);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <h1 className="text-2xl font-semibold">API tokens</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Tokens issued to your programmatic tools (CLI, MCP, agents). To create a
          new token, run the device-login flow from the tool itself.
        </p>
      </header>

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}

      {q.error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          Couldn't load tokens — {(q.error as Error).message}.{' '}
          <button
            type="button"
            onClick={() => q.refetch()}
            className="underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {revoke.error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          Revoke failed — {(revoke.error as Error).message}.
        </div>
      )}

      {q.data && q.data.tokens.length === 0 && (
        <div className="rounded border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No tokens yet. Run the device-login flow from a Primer tool to create one.
        </div>
      )}

      {q.data && q.data.tokens.length > 0 && (
        <div className="space-y-3">
          {q.data.tokens.map((t) => (
            <TokenRow
              key={t.id}
              token={t}
              onRevoke={onRevoke}
              revoking={revoke.isPending && revoke.variables === t.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
