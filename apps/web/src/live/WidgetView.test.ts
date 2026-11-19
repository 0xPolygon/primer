// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { anchorAt, applyLabels, safeSvg } from './WidgetView.tsx';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">' +
  '<text data-text-id="title" x="4" y="14">Signups</text>' +
  '<g data-anchor="bars"><rect data-row="w2" data-col="signups" width="10" height="10"/></g></svg>';

function mount(svg: string): Element {
  const box = document.createElement('div');
  box.innerHTML = svg;
  return box;
}

describe('WidgetView', () => {
  it('shows each label with its current words', () => {
    const box = mount(SVG);
    applyLabels(box, { title: 'Weekly signups' });
    expect(box.querySelector('[data-text-id="title"]')!.textContent).toBe('Weekly signups');
  });

  it('a click names the data point, else the part', () => {
    const box = mount(SVG);
    const target = { tabId: 'main', blockId: 'b1' };
    expect(anchorAt(box.querySelector('rect')!, target)).toEqual({ type: 'data-point', target, row: 'w2', column: 'signups' });
    expect(anchorAt(box.querySelector('g')!, target)).toEqual({ type: 'widget-part', target, anchor: 'bars' });
    expect(anchorAt(box.querySelector('text')!, target)).toBeNull();
  });

  it('only drawing reaches the page', () => {
    expect(safeSvg(SVG)).toBe(SVG);
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/s.svg#a"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect mask="url(https://example.com/m)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red"/></svg>',
      '<div>not svg</div>',
    ]) {
      expect(safeSvg(bad), bad).toBeNull();
    }
  });
});
