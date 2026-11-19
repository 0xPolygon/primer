import { describe, expect, it } from 'vitest';
import { sanitizeUploadedHtml } from '../upload/sanitize.ts';
import { serverEditor } from '../live/editor.ts';
import { embedBlocks, embedSource, readEmbeds } from './embeds.ts';

const PAGE = `<body><h1>Results</h1>
<primer-table data-embed-id="scores"><table><tr><th>Team</th><th>Score</th></tr><tr><td>A</td><td>3</td></tr></table></primer-table>
<primer-code data-embed-id="snippet" lang="ts">const a = 1 &lt; 2;</primer-code>
<primer-mermaid data-embed-id="flow">graph TD
  A--&gt;B</primer-mermaid>
<primer-math data-embed-id="eq">e^{i\\pi} + 1 = 0</primer-math>
</body>`;

describe('Primer blocks in pages', () => {
  it('primer tags survive sanitize with literal ids', () => {
    const out = sanitizeUploadedHtml(PAGE);
    expect(out).toContain('<primer-table data-embed-id="scores">');
    expect(out).toContain('<primer-code data-embed-id="snippet" lang="ts">');
    expect(out).toContain('<primer-mermaid data-embed-id="flow">');
    expect(out).toContain('<primer-math data-embed-id="eq">');
  });

  it('missing embed id is refused at publish', () => {
    expect(readEmbeds('<body><div><primer-table><table></table></primer-table></div></body>')).toEqual({
      refusal: expect.objectContaining({ details: { path: 'body[0]/div[0]/primer-table[0]' } }),
    });
    expect(readEmbeds('<primer-code data-embed-id="a">x</primer-code><primer-code data-embed-id="a">y</primer-code>')).toHaveProperty('refusal');
  });

  it('untouched embeds export verbatim; their blocks are the native ones', async () => {
    const read = readEmbeds(PAGE);
    if (!('embeds' in read)) throw new Error('refused');
    expect(read.embeds.map((e) => [e.embedId, e.kind])).toEqual([
      ['scores', 'table'],
      ['snippet', 'code'],
      ['flow', 'mermaid'],
      ['eq', 'math'],
    ]);
    // An untouched embed's source is its span, byte for byte.
    for (const e of read.embeds) expect(PAGE.slice(...e.span)).toBe(e.html);

    const [table, code, flow, math] = await Promise.all(read.embeds.map(embedBlocks));
    expect(table![0]).toMatchObject({ type: 'table' });
    expect(code).toEqual([{ type: 'codeBlock', props: { language: 'ts' }, content: 'const a = 1 < 2;' }]);
    expect(flow).toEqual([{ type: 'diagram', content: 'graph TD\n  A-->B' }]);
    expect(math).toEqual([{ type: 'mathBlock', content: 'e^{i\\pi} + 1 = 0' }]);

    // An edited code embed serialises back as escaped text.
    const blocks = serverEditor()._prosemirrorJSONToBlocks(
      serverEditor()._blocksToProsemirrorNode([{ ...code![0]!, content: 'a < b' }] as never).toJSON(),
    );
    expect(await embedSource('code', blocks)).toBe('a &lt; b');
  });
});
