import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { Node as PmNode } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { DocumentFormat } from '@polygonlabs/primer-api-types';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';

/**
 * Where an imported group of blocks came from, so export can re-emit it
 * verbatim while it is untouched. One entry per top-level group of the source
 * file (a paragraph, a whole list, a table, a raw HTML chunk…), keyed in the
 * Y.Doc's `sources` map by the group's first block id.
 *
 * - `slice`: the group's exact source lines; `gap`: the blank lines after it.
 * - `groupIds`: the top-level blocks the group became, in order.
 * - `version`: `groupVersion` of those blocks right after import.
 * - `refs`: reference-definition labels the group uses; `defines`: the labels
 *   it defines. A group is verbatim only while every group defining one of its
 *   labels is verbatim too.
 */
export type SourceEntry = {
  slice: string;
  gap: string;
  groupIds: string[];
  version: string;
  refs: string[];
  defines: string[];
};

/** The Y.Doc's `meta` map: how the document was imported. `frontMatter` is
 *  the raw front matter and `lead` the blank lines before the first group. */
export type LiveMeta = { format: DocumentFormat; frontMatter: string; lead: string };

export function sourcesOf(doc: Y.Doc): Y.Map<SourceEntry> {
  return doc.getMap<SourceEntry>('sources');
}

export function metaOf(doc: Y.Doc): LiveMeta {
  const meta = doc.getMap<string>('meta');
  return {
    format: (meta.get('format') as DocumentFormat | undefined) ?? 'markdown',
    frontMatter: meta.get('frontMatter') ?? '',
    lead: meta.get('lead') ?? '',
  };
}

/** A fragment as a ProseMirror doc in Primer's schema. Reads only. */
export function pmDocOf(fragment: Y.XmlFragment): PmNode {
  const schema = serverEditor().editor.pmSchema;
  if (fragment.length === 0) return schema.topNodeType.createAndFill()!;
  return PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
}

/** The recursive version of a group of blocks (C2's block version over each),
 *  or null when one of them is gone. Comment and suggestion marks don't count. */
export function groupVersion(pmDoc: PmNode, ids: string[]): string | null {
  const hash = createHash('sha256');
  for (const id of ids) {
    const found = findBlock(pmDoc, id);
    if (!found) return null;
    hash.update(blockVersion(found.node)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
