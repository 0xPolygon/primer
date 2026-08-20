import { useState } from 'react';
import type { ApiTokenSummary, CreateTokenResponse } from '@polygonlabs/primer-api-types';
import {
  useApiTokens,
  useCreateServiceToken,
  useCreateToken,
  useRevokeServiceToken,
  useRevokeToken,
  useServiceTokens,
} from '../queries/tokens.ts';
import { useMe } from '../queries/me.ts';

const MAX_NAME_LENGTH = 100;

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

interface CreateTokenFormProps {
  placeholder: string;
  pending: boolean;
  error: Error | null;
  onCreate: (name: string) => void;
}

function CreateTokenForm({ placeholder, pending, error, onCreate }: CreateTokenFormProps) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || pending) return;
        onCreate(trimmed);
        setName('');
      }}
    >
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={!valid || pending}
          className="shrink-0 rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          {pending ? 'Creating…' : 'Create token'}
        </button>
      </div>
      {name.length > 0 && !valid && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Name must be 1–{MAX_NAME_LENGTH} characters.
        </p>
      )}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Create failed — {error.message}
        </p>
      )}
    </form>
  );
}

interface SecretRevealProps {
  created: CreateTokenResponse;
  onDismiss: () => void;
}

/**
 * Shows the plaintext token exactly once after creation. The secret lives
 * only in component state — never in the query cache.
 */
function SecretReveal({ created, onDismiss }: SecretRevealProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions) — the user can still select the text.
    }
  }

  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
      <div className="mb-2 text-sm font-medium text-amber-900 dark:text-amber-200">
        Token "{created.summary.name}" created — copy it now. It will not be shown again.
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-white px-2 py-1.5 font-mono text-xs text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
          {created.token}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:bg-neutral-900 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-xs text-amber-800 underline hover:no-underline dark:text-amber-300"
      >
        I've saved it — dismiss
      </button>
    </div>
  );
}

export function TokenSettingsPage() {
  const me = useMe();
  const q = useApiTokens();
  const revoke = useRevokeToken();
  const create = useCreateToken();
  const [createdSecret, setCreatedSecret] = useState<CreateTokenResponse | null>(null);

  const isAdmin = me.data?.isAdmin === true;
  const serviceQ = useServiceTokens(isAdmin);
  const serviceRevoke = useRevokeServiceToken();
  const serviceCreate = useCreateServiceToken();
  const [createdServiceSecret, setCreatedServiceSecret] = useState<CreateTokenResponse | null>(
    null,
  );

  function onRevoke(token: ApiTokenSummary) {
    const confirmed = window.confirm(
      `Revoke token "${token.name}"? Any tool using it will lose access immediately.`
    );
    if (!confirmed) return;
    revoke.mutate(token.id);
  }

  function onRevokeService(token: ApiTokenSummary) {
    const confirmed = window.confirm(
      `Revoke service token "${token.name}"? Any tool acting as Claude with it will lose access immediately.`
    );
    if (!confirmed) return;
    serviceRevoke.mutate(token.id);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <h1 className="text-2xl font-semibold">API tokens</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Tokens authenticate your programmatic tools (CLI, MCP, agents) as you.
          Tokens never expire — revoke any token you no longer use.
        </p>
      </header>

      <CreateTokenForm
        placeholder="Token name, e.g. claude-slack"
        pending={create.isPending}
        error={(create.error as Error) ?? null}
        onCreate={(name) => create.mutate(name, { onSuccess: setCreatedSecret })}
      />

      {createdSecret && (
        <SecretReveal created={createdSecret} onDismiss={() => setCreatedSecret(null)} />
      )}

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
          No tokens yet. Create one above to connect a tool.
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

      {isAdmin && (
        <section className="space-y-4 border-t border-neutral-200 pt-6 dark:border-neutral-800">
          <header>
            <h2 className="text-lg font-semibold">Service account (Claude)</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Tokens here authenticate as the Claude service user — actions performed
              with them are attributed to Claude, not to you. Visible to admins only.
            </p>
          </header>

          <CreateTokenForm
            placeholder="Token name, e.g. claude-slack-workspace"
            pending={serviceCreate.isPending}
            error={(serviceCreate.error as Error) ?? null}
            onCreate={(name) => serviceCreate.mutate(name, { onSuccess: setCreatedServiceSecret })}
          />

          {createdServiceSecret && (
            <SecretReveal
              created={createdServiceSecret}
              onDismiss={() => setCreatedServiceSecret(null)}
            />
          )}

          {serviceQ.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}

          {serviceQ.error && (
            <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              Couldn't load service tokens — {(serviceQ.error as Error).message}.
            </div>
          )}

          {serviceRevoke.error && (
            <div className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              Revoke failed — {(serviceRevoke.error as Error).message}.
            </div>
          )}

          {serviceQ.data && serviceQ.data.tokens.length === 0 && (
            <div className="rounded border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
              No service tokens yet.
            </div>
          )}

          {serviceQ.data && serviceQ.data.tokens.length > 0 && (
            <div className="space-y-3">
              {serviceQ.data.tokens.map((t) => (
                <TokenRow
                  key={t.id}
                  token={t}
                  onRevoke={onRevokeService}
                  revoking={serviceRevoke.isPending && serviceRevoke.variables === t.id}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
