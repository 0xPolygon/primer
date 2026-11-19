import { describe, expect, it } from 'vitest';
import { editablePids, embedHtml } from './pageBridge.ts';

describe('editablePids', () => {
  it('script-drawn pid is read-only', () => {
    const stamped = { p1: 'Revenue by quarter', p2: 'Loading…', p3: 'Line one\nLine two', p4: 'Dropped' };
    const reported = [
      { pid: 'p1', text: '  Revenue   by quarter ' },
      // A chart script replaced the placeholder text.
      { pid: 'p2', text: 'Q3: $1.2M' },
      { pid: 'p3', text: 'Line one \n Line two' },
      // A script cloned a stamped node: both copies are read-only.
      { pid: 'p1', text: 'Revenue by quarter' },
    ];
    expect([...editablePids(stamped, reported)]).toEqual(['p3']);
  });
});

describe('embedHtml', () => {
  it('set_embeds content is text only', () => {
    const cell = (type: string, text: string) => ({ type, content: [{ type: 'tableParagraph', content: [{ type: 'text', text }] }] });
    const table = {
      type: 'doc',
      content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('tableHeader', 'Team'), cell('tableCell', '<img src=x onerror=alert(1)>')] }] }],
    };
    expect(embedHtml(table)).toBe('<table><tr><th>Team</th><td>&lt;img src=x onerror=alert(1)&gt;</td></tr></table>');
    expect(embedHtml({ type: 'doc', content: [{ type: 'diagram', content: [{ type: 'text', text: 'graph TD\n A-->B' }] }] })).toBe(
      '<pre class="mermaid">graph TD\n A--&gt;B</pre>',
    );
  });
});
