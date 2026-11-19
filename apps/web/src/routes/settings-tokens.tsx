import { useState } from 'react';
import { API_TOKEN_SCOPES, API_TOKEN_SCOPE_DESCRIPTIONS } from '@polygonlabs/primer-api-types';
import type {
  AgentDTO,
  ApiTokenScope,
  ApiTokenSummary,
  CreateTokenRequest,
  CreateTokenResponse,
} from '@polygonlabs/primer-api-types';
import {
  useAgents,
  useApiTokens,
  useCreateAgent,
  useCreateAgentToken,
  useCreateToken,
  useRevokeAgentToken,
  useRevokeToken,
} from '../queries/tokens.ts';

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

function ScopeList({ scopes }: { scopes: ApiTokenSummary['scopes'] }) {
  if (scopes === null) {
    return (
      <span
        className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
        title="Can call every endpoint an API token may call"
      >
        Full access
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <span
          key={s}
          title={API_TOKEN_SCOPE_DESCRIPTIONS[s]}
          className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {s}
        </span>
      ))}
    </span>
  );
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
          <ScopeList scopes={token.scopes} />
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
  /** Service tokens must be scoped; personal tokens may be full access. */
  scopesRequired: boolean;
  onCreate: (req: CreateTokenRequest) => void;
}

function CreateTokenForm({ placeholder, pending, error, scopesRequired, onCreate }: CreateTokenFormProps) {
  const [name, setName] = useState('');
  const [limitedChoice, setLimitedChoice] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<ApiTokenScope>>(new Set());
  const limited = scopesRequired || limitedChoice;
  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH;
  const valid = nameValid && (!limited || selected.size > 0);

  function toggle(scope: ApiTokenScope) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || pending) return;
        onCreate(
          limited
            ? { name: trimmed, scopes: API_TOKEN_SCOPES.filter((s) => selected.has(s)) }
            : { name: trimmed },
        );
        setName('');
        setSelected(new Set());
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
      {!scopesRequired && (
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={limitedChoice}
            onChange={(e) => setLimitedChoice(e.target.checked)}
          />
          Limit this token to specific permissions
        </label>
      )}
      {limited && (
        <fieldset className="space-y-1 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          <legend className="px-1 text-xs text-neutral-500">
            Permissions{scopesRequired ? ' (required)' : ''}
          </legend>
          {API_TOKEN_SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(scope)}
                onChange={() => toggle(scope)}
              />
              <span>
                <span className="font-mono text-xs text-neutral-900 dark:text-neutral-100">{scope}</span>
                <span className="block text-xs text-neutral-600 dark:text-neutral-400">
                  {API_TOKEN_SCOPE_DESCRIPTIONS[scope]}
                </span>
              </span>
            </label>
          ))}
          <p className="pt-1 text-xs text-neutral-500">
            Deleting documents, changing visibility, external sharing, and managing tokens are
            never available to a limited token.
          </p>
        </fieldset>
      )}
      {name.length > 0 && !nameValid && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Name must be 1–{MAX_NAME_LENGTH} characters.
        </p>
      )}
      {limited && selected.size === 0 && nameValid && (
        <p className="text-xs text-neutral-500">Select at least one permission.</p>
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
  const q = useApiTokens();
  const revoke = useRevokeToken();
  const create = useCreateToken();
  const [createdSecret, setCreatedSecret] = useState<CreateTokenResponse | null>(null);

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
          Tokens authenticate your programmatic tools (CLI, MCP, agents) as you.
          Tokens never expire — revoke any token you no longer use.
        </p>
      </header>

      <CreateTokenForm
        placeholder="Token name, e.g. claude-slack"
        pending={create.isPending}
        error={(create.error as Error) ?? null}
        scopesRequired={false}
        onCreate={(req) => create.mutate(req, { onSuccess: setCreatedSecret })}
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

      <AgentsSection />
    </div>
  );
}

const ERROR_BOX =
  'rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300';

/** Agents act via you under their own name ("Claude (via you)"), with at
 *  most editor access to your documents. */
function AgentsSection() {
  const q = useAgents();
  const create = useCreateAgent();
  const [name, setName] = useState('');
  const trimmed = name.trim();

  return (
    <section className="space-y-4 border-t border-neutral-200 pt-6 dark:border-neutral-800">
      <header>
        <h2 className="text-lg font-semibold">Agents</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          An agent acts for you under its own name: its comments and documents show
          as theirs, "via" you. It can edit your documents but never delete them,
          change who can see them, or manage collaborators. Give its tokens only the
          permissions the integration needs.
        </p>
      </header>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed.length === 0) return;
          create.mutate({ displayName: trimmed }, { onSuccess: () => setName('') });
        }}
      >
        <input
          type="text"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => setName(e.target.value)}
          placeholder="Agent name, e.g. Claude"
          className="flex-1 rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={trimmed.length === 0 || create.isPending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          Add agent
        </button>
      </form>
      {create.error && <div className={ERROR_BOX}>Couldn't add the agent — {(create.error as Error).message}.</div>}

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}
      {q.error && <div className={ERROR_BOX}>Couldn't load agents — {(q.error as Error).message}.</div>}
      {q.data && q.data.agents.length === 0 && (
        <div className="rounded border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No agents yet.
        </div>
      )}
      {q.data?.agents.map((a) => <AgentCard key={a.id} agent={a} />)}
    </section>
  );
}

function AgentCard({ agent }: { agent: AgentDTO }) {
  const create = useCreateAgentToken(agent.id);
  const revoke = useRevokeAgentToken(agent.id);
  const [created, setCreated] = useState<CreateTokenResponse | null>(null);

  function onRevoke(token: ApiTokenSummary) {
    const confirmed = window.confirm(
      `Revoke token "${token.name}"? Any tool acting as ${agent.displayName} with it will lose access immediately.`,
    );
    if (!confirmed) return;
    revoke.mutate(token.id);
  }

  return (
    <div className="space-y-3 rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <h3 className="font-medium">{agent.displayName}</h3>
      <CreateTokenForm
        placeholder="Token name, e.g. slack-workspace"
        pending={create.isPending}
        error={(create.error as Error) ?? null}
        scopesRequired
        onCreate={(req) => create.mutate(req, { onSuccess: setCreated })}
      />
      {created && <SecretReveal created={created} onDismiss={() => setCreated(null)} />}
      {revoke.error && <div className={ERROR_BOX}>Revoke failed — {(revoke.error as Error).message}.</div>}
      {agent.tokens.map((t) => (
        <TokenRow key={t.id} token={t} onRevoke={onRevoke} revoking={revoke.isPending && revoke.variables === t.id} />
      ))}
    </div>
  );
}
