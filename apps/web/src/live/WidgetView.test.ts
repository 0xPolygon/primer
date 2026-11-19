// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { anchorAt, applyLabels, parseSafeSvg } from './WidgetView.tsx';

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
    expect(parseSafeSvg(SVG)?.querySelector('rect')?.getAttribute('data-row')).toBe('w2');
    const svg = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`;
    for (const bad of [
      svg('<text data-text-id="t"><![CDATA[</text><img src=x onerror=alert(1)>]]></text>'),
      svg('<?xml-stylesheet href="https://example.com/x.css"?><rect/>'),
      svg('<!-- <img src=x onerror=alert(1)> --><rect/>'),
      svg('<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>'),
      svg('<h:img xmlns:h="http://www.w3.org/1999/xhtml" src="x"/>'),
      svg('<script>alert(1)</script>'),
      svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
      svg('<rect/>', ' onload="alert(1)"'),
      svg('<use href="https://example.com/s.svg#a"/>'),
      svg('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#a"/>'),
      svg('<rect mask="url(https://example.com/m)"/>'),
      svg('<rect mask="URL(https://example.com/m)"/>'),
      svg('<rect mask="url (https://example.com/m)"/>'),
      svg('<rect mask="\\75 rl(https://example.com/m)"/>'),
      svg('<rect mask="&#117;rl(https://example.com/m)"/>'),
      svg('<rect mask="&#x55;RL(https://example.com/m)"/>'),
      svg('<rect fill="red"/>'),
      svg('<rect style="fill:red"/>'),
      svg('<rect class="x"/>'),
      '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
      '<div>not svg</div>',
    ]) {
      expect(parseSafeSvg(bad), bad).toBeNull();
    }
  });
});
