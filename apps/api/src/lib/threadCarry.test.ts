// End to end: threads started on one version show on the next, by their
// quoted text, and agents can answer them over MCP.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadDTO, ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { asUserJson } from '../test/harness.ts';
import { bodyText, placeTextRange } from './threadCarry.ts';

const user = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User' };

async function withPrimer<T>(
  fn: (p: {
    app: ReturnType<typeof createApp>;
    tools: ReturnType<typeof buildMcpToolHandlers>;
    storage: FilesystemStorage;
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-carry-test-'));
  try {
    const storage = new FilesystemStorage(root);
    const notifier = new NoopNotifier();
    const app = createApp({ storage, notifier });
    const tools = buildMcpToolHandlers({ storage, notifier, apiBaseUrl: 'https://primer.example.com' });
    return await fn({ app, tools, storage });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Tools = ReturnType<typeof buildMcpToolHandlers>;
type Json = Record<string, unknown>;

async function call(tools: Tools, name: keyof Tools, args: Json): Promise<Json> {
  const res = await tools[name](args, user);
  expect(res.isError, res.content[0].text).toBeFalsy();
  return JSON.parse(res.content[0].text) as Json;
}

/** A position anchor on the first occurrence of `quote`, as the companion
 *  would capture it (raw offsets into the body text). */
async function anchorOn(storage: FilesystemStorage, versionId: string, quote: string) {
  const html = await new Response(await storage.get(`v1/${versionId}.html`)).text();
  const body = bodyText(html);
  const i = body.text.indexOf(quote);
  expect(i).toBeGreaterThanOrEqual(0);
  return {
    type: 'text-range' as const,
    selectorText: quote,
    start: body.rawOffset[i],
    end: body.rawOffset[i + quote.length - 1] + 1,
  };
}

async function startThread(
  p: { app: ReturnType<typeof createApp>; storage: FilesystemStorage },
  versionId: string,
  quote: string,
  body: string,
): Promise<string> {
  const res = await p.app.request(`/api/versions/${versionId}/threads`, {
    method: 'POST',
    headers: asUserJson(user.id),
    body: JSON.stringify({ anchor: await anchorOn(p.storage, versionId, quote), body }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as ThreadDTO).id;
}

async function threadsOn(app: ReturnType<typeof createApp>, versionId: string): Promise<ThreadDTO[]> {
  const res = await app.request(`/api/versions/${versionId}/threads`, { headers: asUserJson(user.id) });
  expect(res.status).toBe(200);
  return ((await res.json()) as ThreadsListResponse).threads;
}

const V1 = `<h1>Plan</h1>
<p>The launch date is Friday, pending review.</p>
<p>Budget stays at ten thousand.</p>
<p>Owner: the platform team.</p>`;

describe('threads across versions', () => {
  it('carries open threads to a new version by their quoted text, or marks the context changed', async () => {
    await withPrimer(async (p) => {
      const created = await call(p.tools, 'primer_create_document', { title: 'Plan', content: V1, format: 'html' });
      const documentId = created.documentId as string;
      const v1 = created.versionId as string;

      const kept = await startThread(p, v1, 'launch date', 'Is this confirmed?');
      const changed = await startThread(p, v1, 'ten thousand', 'Too low.');
      const resolved = await startThread(p, v1, 'platform team', 'Which one?');
      await call(p.tools, 'primer_resolve_thread', { thread_id: resolved });

      // v2: a new paragraph above, reformatted whitespace, the budget rewritten.
      const v2 = (await call(p.tools, 'primer_add_version', {
        documentId,
        format: 'html',
        content: `<h1>Plan</h1><p>New: a summary paragraph.</p>
          <p>The   launch date
          is Friday, pending review.</p>
          <p>Budget is twelve thousand.</p>
          <p>Owner: the platform team.</p>`,
      })).versionId as string;

      const onV2 = new Map((await threadsOn(p.app, v2)).map((t) => [t.id, t]));
      expect([...onV2.keys()].sort()).toEqual([kept, changed].sort());
      expect(onV2.get(kept)).toMatchObject({
        versionId: v1,
        contextChanged: false,
        anchor: { type: 'text-range', selectorText: 'launch date', containerPath: 'body' },
      });
      expect(onV2.get(changed)).toMatchObject({ contextChanged: true, anchor: { selectorText: 'ten thousand' } });

      // The originating version still lists all three, as started.
      const onV1 = await threadsOn(p.app, v1);
      expect(onV1.map((t) => t.id).sort()).toEqual([kept, changed, resolved].sort());
      expect(onV1.every((t) => !t.contextChanged)).toBe(true);
    });
  });

  it('does not place a quote whose text and context occur twice', async () => {
    await withPrimer(async (p) => {
      const created = await call(p.tools, 'primer_create_document', { title: 'Plan', content: V1, format: 'html' });
      const thread = await startThread(p, created.versionId as string, 'launch date', 'Is this confirmed?');
      const v2 = (await call(p.tools, 'primer_add_version', {
        documentId: created.documentId,
        format: 'html',
        content: `${V1}<h1>Plan</h1>\n<p>The launch date is Friday, pending review.</p>\n<p>Budget stays at ten thousand.</p>`,
      })).versionId as string;
      const [t] = await threadsOn(p.app, v2);
      expect(t).toMatchObject({ id: thread, contextChanged: true });
    });
  });

  it('lets an agent read, answer and resolve carried threads over MCP', async () => {
    await withPrimer(async (p) => {
      const created = await call(p.tools, 'primer_create_document', { title: 'Plan', content: V1, format: 'html' });
      const thread = await startThread(p, created.versionId as string, 'launch date', 'Is this confirmed?');
      await call(p.tools, 'primer_add_version', { documentId: created.documentId, format: 'html', content: V1 });

      const listed = await call(p.tools, 'primer_get_comments', { documentId: created.documentId });
      expect(listed.comments).toEqual([
        expect.objectContaining({
          thread_id: thread,
          author_id: user.id,
          body: 'Is this confirmed?',
          anchor_text: 'launch date',
          version_number: 1,
          resolved: false,
          context_changed: false,
        }),
      ]);
      expect(listed.markdown).toContain(`thread ${thread}`);

      const reply = await call(p.tools, 'primer_reply_to_thread', { thread_id: thread, body: 'Addressed in v2.' });
      expect(reply).toMatchObject({ thread_id: thread, comment_id: expect.any(String) });
      expect(await call(p.tools, 'primer_resolve_thread', { thread_id: thread })).toEqual({ thread_id: thread, resolved: true });

      const after = await call(p.tools, 'primer_get_comments', { documentId: created.documentId });
      expect(after.comments).toEqual([
        expect.objectContaining({ comment_id: expect.any(String), resolved: true }),
        expect.objectContaining({ comment_id: reply.comment_id, body: 'Addressed in v2.', resolved: true }),
      ]);

      // Resolved threads stay behind on the next version.
      const v3 = await call(p.tools, 'primer_add_version', { documentId: created.documentId, format: 'html', content: V1 });
      expect(await threadsOn(p.app, v3.versionId as string)).toEqual([]);
    });
  });
});

describe('selections across block boundaries', () => {
  // The browser's selection text carries line breaks between blocks; the DOM
  // text the offsets index has none. The highlight must survive both.
  const cases = [
    { name: 'paragraphs', html: '<p>First paragraph.</p><p>Second paragraph.</p>', text: 'First paragraph.\n\nSecond paragraph.' },
    { name: 'list items', html: '<ul><li>Apples</li><li>Oranges</li></ul>', text: 'Apples\nOranges' },
    { name: 'table cells', html: '<table><tr><td>Owner</td><td>Platform team</td></tr></table>', text: 'Owner\tPlatform team' },
  ];
  const edited = (html: string) => `<p>A new intro, added later.</p>\n${html}\n<p>And a footer.</p>`;

  for (const c of cases) {
    it(`keeps a selection across ${c.name}, unchanged or with an edit elsewhere`, () => {
      const origin = bodyText(c.html);
      const squeezedAt = (needle: string) => origin.text.replace(/ /g, '').indexOf(needle.replace(/\s/g, ''));
      // Offsets as the companion captures them: first to last selected character.
      const chars = [...origin.text].map((ch, i) => ({ ch, i })).filter((x) => x.ch !== ' ');
      const k = squeezedAt(c.text);
      const last = c.text.replace(/\s/g, '').length - 1;
      const withOffsets = {
        type: 'text-range' as const,
        selectorText: c.text,
        start: origin.rawOffset[chars[k].i],
        end: origin.rawOffset[chars[k + last].i] + 1,
      };
      const noOffsets = { type: 'text-range' as const, selectorText: c.text };

      for (const html of [c.html, edited(c.html)]) {
        const target = bodyText(html);
        for (const anchor of [withOffsets, noOffsets]) {
          const placed = placeTextRange(anchor, origin, target);
          expect(placed, `${c.name} on ${html}`).not.toBeNull();
          // The stored quote is the live DOM text (no block-boundary spaces), so the companion can find it.
          const dom = [...target.text].filter((_, i) => !target.synthetic[i]).join('');
          expect(dom).toContain(placed!.selectorText);
          expect(placed!.selectorText.replace(/\s/g, '')).toBe(c.text.replace(/\s/g, ''));
        }
      }
    });
  }

  // Word boundaries are part of the quote: a split or a join is a changed text.
  const wording = [
    { name: 'a split word joined', before: 'Please approve now here today.', quote: 'now here', after: 'Please approve nowhere today.' },
    { name: 'a joined word split', before: 'Please approve nowhere today.', quote: 'nowhere', after: 'Please approve now here today.' },
    { name: 'a space inserted in a word', before: 'Ship the roll out today.', quote: 'roll out', after: 'Ship the rollout today.' },
  ];
  for (const w of wording) {
    it(`reports ${w.name} as context changed`, () => {
      const origin = bodyText(`<p>${w.before}</p>`);
      const start = origin.text.indexOf(w.quote);
      const target = bodyText(`<p>${w.after}</p>`);
      for (const anchor of [
        { type: 'text-range' as const, selectorText: w.quote, start, end: start + w.quote.length },
        { type: 'text-range' as const, selectorText: w.quote },
      ]) {
        expect(placeTextRange(anchor, origin, target)).toBeNull();
      }
    });
  }

  it('still reports a changed quote as context changed', () => {
    const origin = bodyText(cases[0].html);
    const target = bodyText('<p>First paragraph.</p><p>Third paragraph.</p>');
    expect(placeTextRange({ type: 'text-range', selectorText: cases[0].text }, origin, target)).toBeNull();
  });
});
