import type { Hono } from 'hono';
import type { ConvertMarkdownResponse } from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';
import { importMarkdown, sourcePreview, type ImportedBlock } from '../live/import.ts';

/** Pasted text is never a whole file; this keeps a stray paste of one cheap. */
const MAX_MARKDOWN_CHARS = 1_000_000;

export function registerConvertRoute(app: Hono<{ Variables: AppVariables }>): void {
  // The editor's Markdown paste (M10d): the importer's parser, so a paste and
  // an upload of the same text produce the same blocks. Pure conversion: it
  // reads and writes nothing.
  app.post('/api/convert/markdown', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { markdown?: unknown } | null;
    if (typeof body?.markdown !== 'string') return c.json({ error: 'invalid_body', message: 'markdown must be a string' }, 400);
    if (body.markdown.length > MAX_MARKDOWN_CHARS) {
      return c.json({ error: 'too_large', message: `Markdown exceeds ${MAX_MARKDOWN_CHARS} characters.` }, 413);
    }
    const imported = await importMarkdown(body.markdown);
    const blocks = imported.blocks.map(withoutIds);
    // An upload keeps front matter as metadata; a paste has nowhere to put it,
    // so it stays in the document as a source block rather than vanishing.
    if (imported.frontMatter.length > 0) {
      blocks.unshift({ type: 'source', props: { markdown: imported.frontMatter, previewHtml: sourcePreview(imported.frontMatter) }, children: [] });
    }
    const response: ConvertMarkdownResponse = { blocks };
    return c.json(response, 200);
  });
}

type Unidentified = Omit<ImportedBlock, 'id' | 'children'> & { children: Unidentified[] };

/** The editor gives pasted blocks fresh ids, so pasting twice never duplicates one. */
function withoutIds({ id: _id, children, ...block }: ImportedBlock): Unidentified {
  return { ...block, children: children.map(withoutIds) };
}
