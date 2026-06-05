import * as os from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PrimerApiError, type PrimerClient, type PrimerErrorCode } from './client.ts';
import { pollUntil, startDeviceLogin } from './deviceLogin.ts';
import { formatComments } from './format.ts';

/**
 * Public surface of the MCP server. Every tool returns either:
 *   - success: `{ content: [{ type: 'text', text: <JSON or markdown> }] }`
 *   - error:   `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] }`
 *
 * Why JSON-wrap errors (spec D17): the skill needs a machine-checkable
 * `code` to branch on. The MCP SDK's `outputSchema` + `structuredContent`
 * works, but JSON-in-text is simpler, doesn't bind schemas at registration
 * time, and remains backward-compatible with older clients that only
 * surface `content[].text`.
 *
 * Why login is stateless (spec D15): `primer_login` returns the deviceCode
 * to the agent; `primer_login_status` takes it back as an arg. No
 * per-server in-memory stash — survives reconnects.
 */

// ──────────────────────────── Shared types ────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  isError?: boolean;
  content: TextContent[];
}

export type TokenStoreLike = {
  saveToken: (opts: {
    baseUrl: string;
    tokenId: string;
    token: string;
    prefix: string;
  }) => Promise<void>;
  loadToken: (
    baseUrl: string,
  ) => Promise<{ tokenId: string; token: string; prefix: string; savedAt: string } | null>;
  clearToken: (baseUrl: string) => Promise<void>;
  resolveToken: (baseUrl: string) => Promise<string | undefined>;
};

export interface ToolDeps {
  baseUrl: string;
  store: TokenStoreLike;
  /**
   * Builds a `PrimerClient` for the current request, or returns `null` if
   * no token is available. Called on every tool invocation — we never bind
   * a client at registration time because the token can come and go across
   * a long-lived server.
   */
  clientBuilder: () => Promise<PrimerClient | null>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

// ──────────────────────────── Result helpers ────────────────────────────

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function okText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(code: PrimerErrorCode | 'bad_request', message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
  };
}

function errFromException(e: unknown): ToolResult {
  if (e instanceof PrimerApiError) return err(e.code, e.message);
  const message = e instanceof Error ? e.message : String(e);
  return err('bad_request', message);
}

/** Resolves a client; if no token is available, returns a typed error result
 *  that the caller can early-return. */
async function requireClient(
  deps: ToolDeps,
): Promise<{ ok: true; client: PrimerClient } | { ok: false; result: ToolResult }> {
  let client: PrimerClient | null;
  try {
    client = await deps.clientBuilder();
  } catch (e) {
    return { ok: false, result: errFromException(e) };
  }
  if (client === null) {
    return {
      ok: false,
      result: err('not_authenticated', 'Not authenticated — run `primer_login` first.'),
    };
  }
  return { ok: true, client };
}

// ──────────────────────────── Handlers ────────────────────────────

export function buildToolHandlers(deps: ToolDeps): Record<string, ToolHandler> {
  return {
    primer_login: async (args) => {
      const clientLabel = typeof args.clientLabel === 'string' && args.clientLabel.length > 0
        ? args.clientLabel
        : os.hostname();
      try {
        const res = await startDeviceLogin({ baseUrl: deps.baseUrl, clientLabel });
        // Drop verificationUriComplete — see spec D13 (the MCP layer should
        // not return the pre-filled URL; the agent presents the bare URL +
        // userCode so the human types/scans it explicitly).
        return ok({
          deviceCode: res.deviceCode,
          userCode: res.userCode,
          verificationUri: res.verificationUri,
          expiresIn: res.expiresIn,
          interval: res.interval,
        });
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_login_status: async (args) => {
      const deviceCode = args.deviceCode;
      if (typeof deviceCode !== 'string' || deviceCode.length === 0) {
        return err('bad_request', 'deviceCode is required');
      }
      try {
        // The tool is stateless — we don't have the original `interval` from
        // the authorize response. 5s is the canonical default in the spec.
        const state = await pollUntil({
          baseUrl: deps.baseUrl,
          deviceCode,
          interval: 5,
          timeoutMs: 90_000,
        });
        if (state.status === 'approved') {
          await deps.store.saveToken({
            baseUrl: deps.baseUrl,
            tokenId: state.tokenId,
            token: state.token,
            prefix: state.tokenPrefix,
          });
          return ok({
            status: 'approved',
            tokenPrefix: state.tokenPrefix,
            expiresAt: state.expiresAt,
          });
        }
        // pending / denied / expired: surfaced as tagged successes so the
        // skill can branch on `status` without try/catch.
        return ok({ status: state.status });
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_logout: async () => {
      try {
        const entry = await deps.store.loadToken(deps.baseUrl);
        if (entry && entry.tokenId) {
          // Use the deps clientBuilder so tests can inject a fake client
          // without us reaching into PrimerClient's constructor. In
          // production this builds a client bound to the resolved token —
          // the same one whose `tokenId` we're about to revoke.
          const client = await deps.clientBuilder();
          if (client !== null) {
            try {
              await client.revokeToken(entry.tokenId);
            } catch (e) {
              // Swallow `not_found` (already revoked / never existed) and
              // `not_authenticated` (token already invalid server-side) —
              // logout is idempotent; the local state matters.
              if (
                e instanceof PrimerApiError &&
                (e.code === 'not_found' || e.code === 'not_authenticated')
              ) {
                // intentionally fall through
              } else {
                throw e;
              }
            }
          }
        }
        await deps.store.clearToken(deps.baseUrl);
        return ok({ ok: true });
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_whoami: async () => {
      const auth = await requireClient(deps);
      if (!auth.ok) return auth.result;
      try {
        const user = await auth.client.whoami();
        return ok(user);
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_create_document: async (args) => {
      const auth = await requireClient(deps);
      if (!auth.ok) return auth.result;
      try {
        const title = String(args.title);
        const content = String(args.content);
        const format = args.format as 'html' | 'markdown';
        const description = typeof args.description === 'string' ? args.description : undefined;
        const result = await auth.client.createDocument({ title, content, format, description });
        return ok(result);
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_add_version: async (args) => {
      const auth = await requireClient(deps);
      if (!auth.ok) return auth.result;
      try {
        const documentId = String(args.documentId);
        const content = String(args.content);
        const format = args.format as 'html' | 'markdown';
        const versionNote = typeof args.versionNote === 'string' ? args.versionNote : undefined;
        const result = await auth.client.addVersion({ documentId, content, format, versionNote });
        return ok(result);
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_get_document: async (args) => {
      const auth = await requireClient(deps);
      if (!auth.ok) return auth.result;
      try {
        const result = await auth.client.getDocument(String(args.documentId));
        return ok(result);
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_list_versions: async (args) => {
      const auth = await requireClient(deps);
      if (!auth.ok) return auth.result;
      try {
        const result = await auth.client.listVersions(String(args.documentId));
        return ok(result);
      } catch (e) {
        return errFromException(e);
      }
    },

    primer_get_comments: async (args) => {
      const versionId = typeof args.versionId === 'string' && args.versionId.length > 0
        ? args.versionId
        : undefined;
      const documentId = typeof args.documentId === 'string' && args.documentId.length > 0
        ? args.documentId
        : undefined;
      if ((versionId && documentId) || (!versionId && !documentId)) {
        return err('bad_request', 'Provide exactly one of `versionId` or `documentId`.');
      }

      const auth = await requireClient(deps);
      if (!auth.ok) return auth.result;

      try {
        let resolvedVersionId: string;
        let docTitle: string | undefined;
        let versionNumber: number | undefined;
        if (versionId) {
          resolvedVersionId = versionId;
        } else {
          const detail = await auth.client.getDocument(documentId!);
          resolvedVersionId = detail.latestVersion.id;
          docTitle = detail.document.title;
          versionNumber = detail.latestVersion.versionNumber;
        }
        const threads = await auth.client.getVersionThreads(resolvedVersionId);
        return okText(formatComments(threads, docTitle, versionNumber));
      } catch (e) {
        return errFromException(e);
      }
    },
  };
}

// ──────────────────────────── SDK registration ────────────────────────────

interface ToolConfig {
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
}

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  primer_login: {
    description:
      'Start a Primer device-authorization login. Returns deviceCode (pass back to primer_login_status), userCode (show to user), and verificationUri (user opens in a browser).',
    inputSchema: {
      clientLabel: z.string().optional(),
    },
  },
  primer_login_status: {
    description:
      'Long-poll the device-authorization flow. Returns { status: "approved" | "pending" | "denied" | "expired" }. On approved, the token is persisted server-side; the agent does not see it.',
    inputSchema: {
      deviceCode: z.string(),
    },
  },
  primer_logout: {
    description:
      'Revoke the stored Primer API token (server-side) and remove it from the local token store. Idempotent.',
    inputSchema: {},
  },
  primer_whoami: {
    description: 'Return the authenticated Primer user (id, email, displayName).',
    inputSchema: {},
  },
  primer_create_document: {
    description: 'Create a new Primer document and upload the initial version.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      content: z.string(),
      format: z.enum(['html', 'markdown']),
    },
  },
  primer_add_version: {
    description: 'Upload a new version of an existing Primer document.',
    inputSchema: {
      documentId: z.string(),
      content: z.string(),
      format: z.enum(['html', 'markdown']),
      versionNote: z.string().optional(),
    },
  },
  primer_get_document: {
    description: 'Fetch a Primer document with its latest version metadata.',
    inputSchema: {
      documentId: z.string(),
    },
  },
  primer_list_versions: {
    description: 'List all versions of a Primer document, newest first.',
    inputSchema: {
      documentId: z.string(),
    },
  },
  primer_get_comments: {
    description:
      'Fetch the comment threads on a version (or the latest version of a document) and return a markdown summary suitable for the agent to read back.',
    inputSchema: {
      versionId: z.string().optional(),
      documentId: z.string().optional(),
    },
  },
};

/**
 * Wires `buildToolHandlers(deps)` into an `McpServer` instance. Kept thin
 * on purpose — all the testable logic lives in `buildToolHandlers`, which
 * we invoke directly from tests without spinning up the SDK transport.
 */
export function registerTools(
  server: McpServer,
  deps: ToolDeps & { clientLabel?: string },
): void {
  const handlers = buildToolHandlers(deps);
  for (const [name, handler] of Object.entries(handlers)) {
    const config = TOOL_CONFIGS[name];
    if (!config) continue;
    // The MCP SDK's overload doesn't quite match a runtime-typed handler;
    // cast at the boundary so the rest of the file stays strongly typed.
    server.registerTool(
      name,
      { description: config.description, inputSchema: config.inputSchema },
      handler as unknown as Parameters<typeof server.registerTool>[2],
    );
  }
}
