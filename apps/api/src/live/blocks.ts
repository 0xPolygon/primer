import { createHash } from 'node:crypto';
import type { Node as PmNode } from '@tiptap/pm/model';

/** Marks that annotate rather than change content: a comment or suggestion
 *  arriving on a block must not make an agent's precondition stale. */
const ANNOTATION_MARKS = new Set(['comment', 'insertion', 'deletion', 'modification']);

/**
 * `block.version` (C2): 16 hex chars hashing the block's whole subtree (type,
 * props, inline content with mark names and attributes, every descendant), so
 * editing a child changes its parent's version. Annotation marks are left out.
 */
export function blockVersion(node: PmNode): string {
  return createHash('sha256').update(JSON.stringify(stripAnnotations(node.toJSON()))).digest('hex').slice(0, 16);
}

type NodeJson = { marks?: { type: string }[]; content?: NodeJson[]; [key: string]: unknown };

function stripAnnotations(json: NodeJson): NodeJson {
  const out: NodeJson = { ...json };
  if (json.marks) {
    const marks = json.marks.filter((m) => !ANNOTATION_MARKS.has(m.type));
    if (marks.length > 0) out.marks = marks;
    else delete out.marks;
  }
  if (json.content) out.content = mergeTextRuns(json.content.map(stripAnnotations));
  return out;
}

/** A comment on part of a run splits its text node; with the mark gone the
 *  pieces must read as the one run they were, or the version would change. */
function mergeTextRuns(nodes: NodeJson[]): NodeJson[] {
  const out: NodeJson[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (
      last && last.type === 'text' && node.type === 'text' &&
      JSON.stringify(last.marks ?? null) === JSON.stringify(node.marks ?? null)
    ) {
      out[out.length - 1] = { ...last, text: `${last.text as string}${node.text as string}` };
    } else {
      out.push(node);
    }
  }
  return out;
}

/** The `blockContainer` with this id, and its position, or null. */
export function findBlock(doc: PmNode, blockId: string): { pos: number; node: PmNode } | null {
  let found: { pos: number; node: PmNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'blockContainer' && node.attrs.id === blockId) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}
