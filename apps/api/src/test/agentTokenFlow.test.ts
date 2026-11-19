import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { composeResolvers, makeBearerResolver } from '../auth/bearer.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { apiTokens, comments, documents, users } from '../db/schema.ts';
import { asUserJson } from './harness.ts';
import { uploadFixture } from '../routes/upload.testlib.ts';
import { API_TOKEN_SCOPES } from '@polygonlabs/primer-api-types';
import type { CreateTokenResponse } from '@polygonlabs/primer-api-types';

/**
 * End-to-end flow for an agent: a person creates an agent and mints its
 * token, then EVERYTHING the token does — MCP tool calls (whoami, create,
 * query) and REST commenting — is authenticated purely by the bearer and
 * attributed to the agent. Finally the token is revoked and access dies.
 */

const ADMIN_ID = 'admin-user';
const ADMIN_EMAIL = `${ADMIN_ID}@polygon.technology`;

// authBaseUrl doubles as the OAuth issuer, which is what gates /mcp registration.
const BASE_URL = 'http://localhost:5173';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-agent-flow-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
      authBaseUrl: BASE_URL,
      adminEmails: [ADMIN_EMAIL],
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Bearer-only variant — no mock fallback, so a dead bearer is truly a 401. */
async function withBearerOnlyApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-agent-flow-bearer-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: makeBearerResolver(),
      authBaseUrl: BASE_URL,
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Calls an MCP tool over the real /mcp HTTP transport (stateless streamable
 * HTTP — each POST stands alone) and returns the parsed tool payload.
 */
async function mcpToolCall(
  app: ReturnType<typeof createApp>,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; payload?: Record<string, unknown>; isError?: boolean }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) return { status: res.status };

  // Responses arrive as SSE: `event: message\ndata: {...}`.
  const text = await res.text();
  const dataLine = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .pop();
  if (!dataLine) throw new Error(`no SSE data line in MCP response: ${text}`);
  const rpc = JSON.parse(dataLine.slice('data: '.length)) as {
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
  };
  const inner = rpc.result?.content?.[0]?.text;
  return {
    status: res.status,
    isError: rpc.result?.isError === true,
    payload: inner ? (JSON.parse(inner) as Record<string, unknown>) : undefined,
  };
}

let AGENT_ID = '';

async function mintAgentToken(app: ReturnType<typeof createApp>): Promise<CreateTokenResponse> {
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: asUserJson(ADMIN_ID),
    body: JSON.stringify({ displayName: 'Claude' }),
  });
  expect(created.status).toBe(201);
  AGENT_ID = ((await created.json()) as { id: string }).id;
  const res = await app.request(`/api/agents/${AGENT_ID}/tokens`, {
    method: 'POST',
    headers: asUserJson(ADMIN_ID),
    body: JSON.stringify({ name: 'e2e-flow', scopes: API_TOKEN_SCOPES }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateTokenResponse;
}

const ANCHOR = {
  type: 'text-range',
  selectorText: 't',
  prefix: '',
  suffix: '',
  containerPath: 'body',
};

beforeEach(async () => {
  await db.delete(apiTokens);
  await db
    .insert(users)
    .values([{ id: ADMIN_ID, email: ADMIN_EMAIL, displayName: ADMIN_ID }])
    .onConflictDoNothing();
});

describe('agent token end-to-end flow', () => {
  it('mint → whoami → create document → query it back → comment on a human doc, all as the agent', async () => {
    await withApp(async (app) => {
      const minted = await mintAgentToken(app);
      const token = minted.token;

      // 1. whoami over MCP identifies the agent, acting via the admin.
      const who = await mcpToolCall(app, token, 'primer_whoami', {});
      expect(who.status).toBe(200);
      expect(who.isError).toBeFalsy();
      expect(who.payload?.id).toBe(AGENT_ID);
      expect(who.payload?.displayName).toBe('Claude (via admin-user)');

      // 2. Create a document over MCP; ownership lands on the agent.
      const created = await mcpToolCall(app, token, 'primer_create_document', {
        title: 'Claude flow test doc',
        content: '# Hello\n\nWritten by an agent.',
        format: 'markdown',
      });
      expect(created.status).toBe(200);
      expect(created.isError).toBeFalsy();
      const documentId = created.payload?.documentId as string;
      expect(documentId).toBeTruthy();

      const [docRow] = await db.select().from(documents).where(eq(documents.id, documentId));
      expect(docRow.uploaderId).toBe(AGENT_ID);

      // 3. Query it back over MCP.
      const fetched = await mcpToolCall(app, token, 'primer_get_document', { documentId });
      expect(fetched.status).toBe(200);
      expect(fetched.isError).toBeFalsy();
      expect(JSON.stringify(fetched.payload)).toContain('Claude flow test doc');

      // 4. It shows up in the agent's own document list.
      const listed = await mcpToolCall(app, token, 'primer_list_documents', { scope: 'mine' });
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.payload)).toContain(documentId);

      // 5. A human (mock-user-1) uploads an org-visible doc; Claude comments
      //    on it via REST using only the bearer (bearer requests skip CSRF).
      const humanDoc = await uploadFixture(app);
      const threadRes = await app.request(`/api/versions/${humanDoc.versionId}/threads`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ anchor: ANCHOR, body: 'Comment from an agent.' }),
      });
      expect(threadRes.status).toBe(201);
      const thread = (await threadRes.json()) as { id: string; commentId: string };

      const [commentRow] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, thread.commentId));
      expect(commentRow.authorId).toBe(AGENT_ID);

      // 6. Claude replies on the same thread.
      const replyRes = await app.request(`/api/threads/${thread.id}/comments`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: 'Follow-up from an agent.' }),
      });
      expect(replyRes.status).toBe(201);
      const reply = (await replyRes.json()) as { comment: { id: string; authorId: string } };
      expect(reply.comment.authorId).toBe(AGENT_ID);
      const [replyRow] = await db
        .select()
        .from(comments)
        .where(eq(comments.id, reply.comment.id));
      expect(replyRow.authorId).toBe(AGENT_ID);
    });
  });

  it('revoked token loses MCP and REST access (bearer-only, no fallback)', async () => {
    let token = '';
    let tokenId = '';

    await withApp(async (app) => {
      const minted = await mintAgentToken(app);
      token = minted.token;
      tokenId = minted.summary.id;
    });

    // Works before revocation.
    await withBearerOnlyApp(async (app) => {
      const who = await mcpToolCall(app, token, 'primer_whoami', {});
      expect(who.status).toBe(200);
      expect(who.payload?.id).toBe(AGENT_ID);
    });

    // Admin revokes.
    await withApp(async (app) => {
      const res = await app.request(`/api/agents/${AGENT_ID}/tokens/${tokenId}`, {
        method: 'DELETE',
        headers: asUserJson(ADMIN_ID),
      });
      expect(res.status).toBe(200);
    });

    // MCP and REST both reject the dead bearer with 401.
    await withBearerOnlyApp(async (app) => {
      const who = await mcpToolCall(app, token, 'primer_whoami', {});
      expect(who.status).toBe(401);

      const rest = await app.request('/api/tokens', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(rest.status).toBe(401);
    });
  });
});
