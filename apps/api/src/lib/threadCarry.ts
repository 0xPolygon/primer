// Carries open comment threads onto a newly published version.
//
// A thread belongs to its document. When a version is published, every open
// thread gets a placement on it. The thread is placed where its quoted text
// occurs with the same text right before it or right after it (CONTEXT_CHARS
// characters) as on the version it was started on, if that is exactly one
// place. Otherwise the placement has no anchor and the thread shows as
// "context changed". There is no fuzzy matching: a thread is either on the
// exact words it was about or it says that it isn't.
//
// The match runs on the version's <body> text as the companion's text walk sees
// it (every text node in document order, script and style text included), with
// whitespace ignored in the comparison, so neither reformatting the HTML nor the
// line breaks of a selection across blocks move a thread.
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnchorData, TextRangeAnchor } from '@polygonlabs/primer-api-types';
import { isElementPathAnchor, isTextRangeAnchor } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { threadPlacements, threads, versions } from '../db/schema.ts';
import type { Storage } from '../storage/types.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Characters of surrounding text compared on each side of the quote. */
export const CONTEXT_CHARS = 32;

export interface BodyText {
  /** Body text with every whitespace run collapsed to one space. */
  text: string;
  /** For each character of `text`, its offset in the raw (uncollapsed) text. */
  rawOffset: number[];
}

/** The collapsed text of an HTML document's <body>. */
export function bodyText(html: string): BodyText {
  const doc = parse(html);
  const htmlEl = doc.childNodes.find((n) => (n as Element).tagName === 'html') as Element | undefined;
  const body = htmlEl?.childNodes.find((n) => (n as Element).tagName === 'body') as Element | undefined;
  let raw = '';
  const walk = (node: Node): void => {
    if (node.nodeName === '#text') {
      raw += (node as DefaultTreeAdapterMap['textNode']).value;
      return;
    }
    // <template> content lives in `content`, which a DOM text walk skips too.
    for (const child of (node as Element).childNodes ?? []) walk(child);
  };
  if (body) walk(body);

  let text = '';
  const rawOffset: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (text.endsWith(' ')) continue;
      text += ' ';
    } else {
      text += raw[i];
    }
    rawOffset.push(i);
  }
  return { text, rawOffset };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function squeeze(s: string): string {
  return s.replace(/\s+/g, '');
}

/** The body text with all whitespace removed, and for each of its characters
 *  the index in `BodyText.text`. Matching runs on this form because a browser
 *  selection spanning blocks carries line breaks the DOM text walk never has
 *  (`<p>a</p><p>b</p>` is "ab" there, "a\n\nb" in the selection), so the two
 *  can only be compared modulo whitespace. */
interface Squeezed {
  text: string;
  at: number[];
}

const squeezed = new WeakMap<BodyText, Squeezed>();

function squeezedOf(body: BodyText): Squeezed {
  let sq = squeezed.get(body);
  if (!sq) {
    sq = { text: '', at: [] };
    for (let i = 0; i < body.text.length; i++) {
      if (body.text[i] === ' ') continue;
      sq.text += body.text[i];
      sq.at.push(i);
    }
    squeezed.set(body, sq);
  }
  return sq;
}

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** First index in `list` whose value is >= `value` (list is ascending). */
function lowerBound(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The quote with its context on the originating version, all whitespace-free,
 *  or null when the anchor can't be pinned to one place there. */
function quoteInOrigin(
  anchor: TextRangeAnchor,
  origin: BodyText,
): { prefix: string; quote: string; suffix: string } | null {
  const quote = squeeze(anchor.selectorText);
  if (quote.length === 0) return null;

  // Legacy anchors carry their own context.
  if (typeof anchor.prefix === 'string' && typeof anchor.suffix === 'string') {
    return {
      prefix: squeeze(collapse(anchor.prefix).slice(-CONTEXT_CHARS)),
      quote,
      suffix: squeeze(collapse(anchor.suffix).slice(0, CONTEXT_CHARS)),
    };
  }

  // Position anchors: the offsets index the live DOM text, which matches the
  // stored HTML unless the document's scripts changed it. Use the offsets when
  // they point at the quote; else the quote's only occurrence; else give up.
  const sq = squeezedOf(origin);
  let at = -1;
  if (typeof anchor.start === 'number' && typeof anchor.end === 'number') {
    const from = lowerBound(sq.at, lowerBound(origin.rawOffset, anchor.start));
    const to = lowerBound(sq.at, lowerBound(origin.rawOffset, anchor.end));
    if (sq.text.slice(from, to) === quote) at = from;
  }
  if (at === -1) {
    const hits = occurrences(sq.text, quote);
    if (hits.length !== 1) return null;
    at = hits[0];
  }
  // Context is CONTEXT_CHARS of the collapsed text, then compared without whitespace.
  const from = sq.at[at];
  const to = sq.at[at + quote.length - 1] + 1;
  return {
    prefix: squeeze(origin.text.slice(Math.max(0, from - CONTEXT_CHARS), from)),
    quote,
    suffix: squeeze(origin.text.slice(to, to + CONTEXT_CHARS)),
  };
}

/**
 * Places a text-range anchor from its originating version onto a target
 * version. Returns the anchor to store for the target, or null when there
 * isn't exactly one occurrence of the quote with its preceding or following
 * context unchanged ("context changed"). Whitespace, including the line breaks
 * a selection across blocks carries, is ignored in the comparison.
 *
 * The returned anchor uses the context shape (`prefix`/`selectorText`/`suffix`
 * with `containerPath: 'body'`) built from the target's own text, which the
 * companion resolves by searching the live text, so it can never highlight
 * different words than the ones matched.
 */
export function placeTextRange(
  anchor: TextRangeAnchor,
  origin: BodyText,
  target: BodyText,
): TextRangeAnchor | null {
  const q = quoteInOrigin(anchor, origin);
  if (!q) return null;
  const sq = squeezedOf(target);
  const candidates = new Set([
    ...occurrences(sq.text, q.prefix + q.quote).map((i) => i + q.prefix.length),
    ...occurrences(sq.text, q.quote + q.suffix),
  ]);
  if (candidates.size !== 1) return null;
  const [k] = candidates;
  const from = sq.at[k];
  const to = sq.at[k + q.quote.length - 1] + 1;
  return {
    type: 'text-range',
    selectorText: target.text.slice(from, to),
    prefix: target.text.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: target.text.slice(to, to + CONTEXT_CHARS),
    containerPath: 'body',
  };
}

const OPEN_THREADS_WHERE = (documentId: string) =>
  and(
    eq(threads.documentId, documentId),
    isNull(threads.resolvedAt),
    sql`EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = ${threads.id} AND c.deleted_at IS NULL)`,
  );

/** The text of the versions the document's open threads were started on. Read
 *  before the publish transaction opens so blob reads stay out of it; a thread
 *  started in between is read on demand by `carryOpenThreads`. */
export async function loadCarryOrigins(
  storage: Storage,
  documentId: string,
): Promise<Map<string, BodyText>> {
  const origins = await db
    .selectDistinct({ id: threads.versionId, storageKey: versions.storageKey })
    .from(threads)
    .innerJoin(versions, eq(versions.id, threads.versionId))
    .where(OPEN_THREADS_WHERE(documentId));
  const texts = new Map<string, BodyText>();
  for (const o of origins) texts.set(o.id!, bodyText(await new Response(await storage.get(o.storageKey)).text()));
  return texts;
}

/**
 * Adds a placement on `versionId` for every open thread of the document that
 * still has a live comment, matching each from the anchor it was started with.
 * Element anchors carry over unchanged: the companion checks the element's
 * content hash and marks the thread unplaced when it differs.
 */
export async function carryOpenThreads(
  tx: Tx,
  storage: Storage,
  args: { documentId: string; versionId: string; html: string; origins: Map<string, BodyText> },
): Promise<void> {
  const open = await tx
    .select({
      id: threads.id,
      anchor: threads.anchor,
      originVersionId: threads.versionId,
      originStorageKey: versions.storageKey,
    })
    .from(threads)
    .innerJoin(versions, eq(versions.id, threads.versionId))
    .where(OPEN_THREADS_WHERE(args.documentId));
  if (open.length === 0) return;

  const target = bodyText(args.html);
  const rows: { threadId: string; versionId: string; anchor: AnchorData | null }[] = [];
  for (const t of open) {
    let anchor: AnchorData | null = null;
    if (isElementPathAnchor(t.anchor)) {
      anchor = t.anchor;
    } else if (isTextRangeAnchor(t.anchor)) {
      let origin = args.origins.get(t.originVersionId!);
      if (!origin) {
        origin = bodyText(await new Response(await storage.get(t.originStorageKey)).text());
        args.origins.set(t.originVersionId!, origin);
      }
      anchor = placeTextRange(t.anchor, origin, target);
    }
    rows.push({ threadId: t.id, versionId: args.versionId, anchor });
  }
  await tx.insert(threadPlacements).values(rows);
}
