import { describe, expect, it } from 'vitest';
import type { ConvertMarkdownResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { importMarkdown, type ImportedBlock } from '../live/import.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { CSRF_HEADERS } from '../test/harness.ts';

const SOURCE = '# Plan\n\nShip **the editor** first.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<details><summary>raw</summary>html</details>\n';

const bare = (b: ImportedBlock): unknown => ({ type: b.type, props: b.props, content: b.content, children: b.children.map(bare) });

describe('POST /api/convert/markdown', () => {
  const app = createApp({ storage: new FilesystemStorage('/tmp/primer-convert-test'), notifier: new NoopNotifier() });
  const post = (body: unknown) =>
    app.request('/api/convert/markdown', { method: 'POST', headers: { ...CSRF_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('pasted Markdown becomes the same blocks as an upload', async () => {
    const res = await post({ markdown: SOURCE });
    expect(res.status).toBe(200);
    const { blocks } = (await res.json()) as ConvertMarkdownResponse;
    const uploaded = (await importMarkdown(SOURCE)).blocks.map(bare);
    // Ids differ by design: the editor assigns them on insert.
    expect(JSON.parse(JSON.stringify(uploaded))).toEqual(blocks);
    expect(JSON.stringify(blocks)).not.toMatch(/"id"/);
    expect(blocks.some((b) => (b as { type: string }).type === 'table')).toBe(true);
    expect(blocks.some((b) => (b as { type: string }).type === 'source')).toBe(true);
  });

  it('front matter stays in the paste as a source block, and bad bodies are refused', async () => {
    const { blocks } = (await (await post({ markdown: '---\ntitle: X\n---\n\nHello\n' })).json()) as ConvertMarkdownResponse;
    expect(blocks[0]).toMatchObject({ type: 'source', props: { markdown: '---\ntitle: X\n---\n' } });
    expect((await post({ markdown: 3 })).status).toBe(400);
    expect((await post({ markdown: 'x'.repeat(1_000_001) })).status).toBe(413);
  });
});
