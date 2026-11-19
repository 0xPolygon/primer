import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_SCOPES, type CreateTokenResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { composeResolvers, makeBearerResolver } from '../auth/bearer.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { createLiveDoc, paragraph, seedBlocks } from '../live/live.testlib.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { asUser, asUserJson } from '../test/harness.ts';

type App = ReturnType<typeof createApp>;
const ADMIN_ID = 'widget-admin';

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-widgets-'));
  try {
    return await fn(
      createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
        authBaseUrl: 'http://localhost:5173',
        adminEmails: [`${ADMIN_ID}@polygon.technology`],
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function agentToken(app: App): Promise<{ agentId: string; token: string }> {
  await db.insert(users).values({ id: ADMIN_ID, email: `${ADMIN_ID}@polygon.technology`, displayName: 'Admin' }).onConflictDoNothing();
  const created = await app.request('/api/agents', { method: 'POST', headers: asUserJson(ADMIN_ID), body: JSON.stringify({ displayName: 'Claude' }) });
  const agentId = ((await created.json()) as { id: string }).id;
  const res = await app.request(`/api/agents/${agentId}/tokens`, {
    method: 'POST',
    headers: asUserJson(ADMIN_ID),
    body: JSON.stringify({ name: 'widgets', scopes: API_TOKEN_SCOPES }),
  });
  return { agentId, token: ((await res.json()) as CreateTokenResponse).token };
}

type ToolResult = { isError?: boolean; content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] };

async function mcp(app: App, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const line = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).pop()!;
  return (JSON.parse(line.slice(6)) as { result: ToolResult }).result;
}

const textOf = (result: ToolResult) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;

const CHART = `export default function render({ rows, tokens }) {
  return (
    <svg viewBox="0 0 300 120">
      <text data-text-id="title" x="10" y="20" fill={tokens.fg}>Signups by week</text>
      {rows.map((r, i) => <rect data-row={r.id} data-col="signups" x={10 + i * 40} y={110 - r.signups / 5} width="30" height={r.signups / 5} fill={tokens.accent1} />)}
    </svg>
  );
}`;

describe('widgets over MCP and REST', () => {
  it('an agent drafts with previews, fixes errors by line, publishes, and people read the image', async () => {
    await withApp(async (app) => {
      const { agentId, token } = await agentToken(app);
      const documentId = await createLiveDoc({ uploaderId: agentId });
      await seedBlocks(documentId, [paragraph('intro', 'Intro')]);

      const bad = await mcp(app, token, 'primer_widget_draft', { documentId, source: CHART.replace('{tokens.accent1}', '"steelblue"') });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toMatchObject({ code: 'widget_invalid', errors: [{ line: 5, message: 'Literal colour "steelblue" in `fill`.' }] });

      const rows = [{ id: 'w1', signups: 240 }, { id: 'w2', signups: 410 }];
      const draft = await mcp(app, token, 'primer_widget_draft', { documentId, source: CHART, rows, afterBlockId: 'intro' });
      expect(draft.isError).toBeFalsy();
      expect(draft.content.map((c) => c.type)).toEqual(['text', 'image', 'image']);
      const { widgetId, previewHash } = textOf(draft) as { widgetId: string; previewHash: string };

      const published = await mcp(app, token, 'primer_widget_publish', { widgetId, previewHash });
      expect(textOf(published)).toMatchObject({ widgetId, publishedHash: previewHash });

      // The owner's person (the agent's via) reads the live image.
      const svg = await app.request(`/api/widgets/${widgetId}/image?theme=dark`, { headers: asUser(ADMIN_ID) });
      expect(svg.headers.get('content-type')).toContain('image/svg+xml');
      expect(await svg.text()).toContain('data-row="w2" data-col="signups"');

      const read = await mcp(app, token, 'primer_widget_get', { widgetId });
      expect(read.content.map((c) => c.type)).toEqual(['text', 'image']);
      expect(textOf(read)).toMatchObject({ labels: { title: 'Signups by week' }, rows, draft: null });

      const stale = await app.request(`/api/widgets/${widgetId}/publish`, {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ previewHash }),
      });
      expect(stale.status).toBe(422);
      expect(((await stale.json()) as { refusal: { code: string } }).refusal.code).toBe('widget_invalid');
    });
  });
});

describe('the widget skill resource', () => {
  it('MCP serves widgets.md as primer://skills/widgets', async () => {
    await withApp(async (app) => {
      const { token } = await agentToken(app);
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'primer://skills/widgets' } }),
      });
      const line = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).pop()!;
      const { result } = JSON.parse(line.slice(6)) as { result: { contents: { text: string }[] } };
      expect(result.contents[0]!.text).toContain('# Widgets: diagrams and charts in Primer');
    });
  });
});
