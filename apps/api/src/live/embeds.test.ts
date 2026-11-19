import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, users } from '../db/schema.ts';
import { OWNER, seedRecordsDoc } from '../records/records.testlib.ts';
import { resolveEmbed, readMeta, type Page } from './embeds.ts';
import { createLiveDoc, paragraph, seedBlocks } from './live.testlib.ts';

const OUTSIDER: AuthUser = { id: 'embed-outsider', email: 'outsider@p.t', displayName: 'Dee', kind: 'person', viaUserId: null };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

const PAGE_HTML = `<!doctype html><html><head><title>Fallback</title>
<meta property="og:title" content="Quarterly‮ report">
<meta property="og:description" content="Numbers   for the quarter">
<meta property="og:site_name" content="Acme">
<meta property="og:image" content="/card.png"></head><body>ignored</body></html>`;

function fakeWeb(responses: Record<string, { status?: number; type: string; body: Buffer | string }>): { page: Page; fetched: string[] } {
  const fetched: string[] = [];
  const page: Page = async (url) => {
    fetched.push(url);
    const r = responses[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return { url, status: r.status ?? 200, contentType: r.type, body: Buffer.from(r.body) };
  };
  return { page, fetched };
}

async function seedUsers(): Promise<void> {
  await seedRecordsDoc();
  await db.insert(users).values({ ...OUTSIDER }).onConflictDoNothing();
}

async function hostWith(props: Record<string, string>, blockId = 'emb1'): Promise<string> {
  await seedUsers();
  const host = await createLiveDoc({ uploaderId: OWNER.id, visibility: 'org' });
  await seedBlocks(host, [paragraph('p1', 'Intro'), { id: blockId, type: 'embed', props } as never]);
  return host;
}

describe('embed blocks', () => {
  it('a link card is read on the server: text and one inlined image', async () => {
    const host = await hostWith({ url: 'https://news.example/q3' });
    const web = fakeWeb({
      'https://news.example/q3': { type: 'text/html; charset=utf-8', body: PAGE_HTML },
      'https://news.example/card.png': { type: 'image/png', body: PNG },
    });
    const res = await resolveEmbed(OUTSIDER, host, 'emb1', web.page);
    expect(res.ok && res.value).toEqual({
      echo: { url: 'https://news.example/q3', documentId: '' },
      kind: 'link',
      url: 'https://news.example/q3',
      title: 'Quarterly report',
      description: 'Numbers for the quarter',
      siteName: 'Acme',
      image: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    // A second viewer is served from the cache, not a second fetch.
    await resolveEmbed(OWNER, host, 'emb1', web.page);
    expect(web.fetched).toHaveLength(2);
  });

  it('an image that is not a raster by content, and a page that is not HTML, give no image and no text', async () => {
    const host = await hostWith({ url: 'https://news.example/svg' });
    const svg = fakeWeb({
      'https://news.example/svg': { type: 'text/html', body: '<meta property="og:title" content="T"><meta property="og:image" content="https://news.example/x.svg">' },
      'https://news.example/x.svg': { type: 'image/svg+xml', body: '<svg onload="alert(1)"/>' },
    });
    const a = await resolveEmbed(OWNER, host, 'emb1', svg.page);
    expect(a.ok && a.value).toMatchObject({ kind: 'link', title: 'T', image: null });

    const host2 = await hostWith({ url: 'https://news.example/file.pdf' });
    const pdf = fakeWeb({ 'https://news.example/file.pdf': { type: 'application/pdf', body: '%PDF' } });
    const b = await resolveEmbed(OWNER, host2, 'emb1', pdf.page);
    expect(b.ok && b.value).toMatchObject({ kind: 'link', title: '', description: '', image: null });
  });

  it('a link that points inside the network is refused by the real fetcher and shows as a bare link', async () => {
    const host = await hostWith({ url: 'http://169.254.169.254/latest/meta-data' });
    const res = await resolveEmbed(OWNER, host, 'emb1');
    expect(res.ok && res.value).toMatchObject({ kind: 'link', title: '', image: null });
  });

  it('a document embed shows its title and excerpt to a viewer who can read it, and nothing to one who cannot', async () => {
    await seedUsers();
    const target = await createLiveDoc({ uploaderId: OWNER.id, visibility: 'private' });
    await db.update(documents).set({ title: 'Launch plan' }).where(eq(documents.id, target));
    await seedBlocks(target, [paragraph('t1', 'Ship on Tuesday.')]);
    const host = await hostWith({ documentId: target });

    const owner = await resolveEmbed(OWNER, host, 'emb1');
    expect(owner.ok && owner.value).toEqual({
      echo: { url: '', documentId: target },
      kind: 'document',
      documentId: target,
      title: 'Launch plan',
      excerpt: 'Ship on Tuesday.',
    });
    // The outsider can read the host (org-visible) but not the private target.
    const outsider = await resolveEmbed(OUTSIDER, host, 'emb1');
    expect(outsider.ok && outsider.value).toEqual({ echo: { url: '', documentId: target }, kind: 'none' });
    // A missing document looks the same.
    const ghost = await hostWith({ documentId: uuidv7() });
    const missing = await resolveEmbed(OWNER, ghost, 'emb1');
    expect(missing.ok && missing.value).toMatchObject({ kind: 'none' });
  });

  it('ids read from the document are validated and scoped to the document asked about', async () => {
    const forged = await hostWith({ documentId: '../../etc/passwd' });
    const a = await resolveEmbed(OWNER, forged, 'emb1');
    expect(a.ok && a.value).toMatchObject({ kind: 'none' });
    // An embed block of another document can't be read through this one.
    const other = await hostWith({ url: 'https://news.example/q3' }, 'other-embed');
    const b = await resolveEmbed(OWNER, forged, 'other-embed');
    expect(b.ok).toBe(false);
    const c = await resolveEmbed(OWNER, other, 'emb1');
    expect(c.ok).toBe(false);
    // Not a block id, and not a document id.
    expect((await resolveEmbed(OWNER, forged, '../x')).ok).toBe(false);
    expect((await resolveEmbed(OWNER, 'not-a-uuid', 'emb1')).ok).toBe(false);
  });

  it('a viewer who cannot read the host document learns nothing from its embeds', async () => {
    await seedUsers();
    const host = await createLiveDoc({ uploaderId: OWNER.id, visibility: 'private' });
    await seedBlocks(host, [{ id: 'emb1', type: 'embed', props: { url: 'https://news.example/q3' } } as never]);
    const res = await resolveEmbed(OUTSIDER, host, 'emb1');
    expect(res.ok).toBe(false);
  });

  it('readMeta prefers Open Graph, falls back to the title, and strips control characters', () => {
    expect(readMeta('<title>Only title</title>')).toMatchObject({ title: 'Only title', description: '', image: '' });
    expect(readMeta('<meta name="description" content="d\u0000x"><title>T</title>')).toMatchObject({ title: 'T', description: 'd x' });
  });
});
