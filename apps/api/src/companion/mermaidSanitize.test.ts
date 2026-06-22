// apps/api/src/companion/mermaidSanitize.test.ts
//
// Mirror tests for the Mermaid SVG attribute scrubbing in v1.js. The
// companion is plain ES2020 served verbatim into the iframe, so the
// helpers below are a self-contained mirror of the scrub logic. If you
// change v1.js, mirror the change here (and vice versa).
//
// Pattern lifted from mermaidScanner.test.ts.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

// ── Mirror of v1.js logic — keep in sync ──────────────────────────────

function scrubMermaidSvgAttributes(node: Element): void {
  if (node.nodeType !== 1) return; // ELEMENT_NODE
  const attrs: Attr[] = [];
  for (const attr of node.attributes) attrs.push(attr);
  for (const attr of attrs) {
    const name = attr.name.toLowerCase();
    const value = String(attr.value || '').trim().toLowerCase();
    if (
      name.indexOf('on') === 0 ||
      value.indexOf('javascript:') === 0 ||
      value.indexOf('vbscript:') === 0
    ) {
      node.removeAttributeNode(attr);
    }
  }
  for (
    let child = node.firstElementChild;
    child;
    child = child.nextElementSibling
  ) {
    scrubMermaidSvgAttributes(child);
  }
}

function safelySetSvgContent(wrapper: Element, svgString: string): void {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'text/html');
  const svgEl = doc.body.querySelector('svg');
  if (!svgEl) {
    throw new Error('no <svg> root found in render output');
  }
  scrubMermaidSvgAttributes(svgEl);
  while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  wrapper.appendChild(document.adoptNode(svgEl));
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('scrubMermaidSvgAttributes', () => {
  it('strips on* event-handler attributes from the root element', () => {
    document.body.innerHTML = '<svg onload="alert(1)" onclick="evil()"><g></g></svg>';
    const svg = document.body.querySelector('svg')!;
    scrubMermaidSvgAttributes(svg);
    expect(svg.hasAttribute('onload')).toBe(false);
    expect(svg.hasAttribute('onclick')).toBe(false);
  });

  it('strips on* attributes from descendant elements', () => {
    document.body.innerHTML =
      '<svg><g onmouseover="x()"><rect onfocus="y()"/></g></svg>';
    const svg = document.body.querySelector('svg')!;
    scrubMermaidSvgAttributes(svg);
    expect(svg.querySelector('g')!.hasAttribute('onmouseover')).toBe(false);
    expect(svg.querySelector('rect')!.hasAttribute('onfocus')).toBe(false);
  });

  it('strips javascript: URLs (case-insensitive, leading-whitespace tolerant)', () => {
    document.body.innerHTML =
      '<svg><a href="javascript:alert(1)"></a><a href=" JavaScript:bad()"></a></svg>';
    const svg = document.body.querySelector('svg')!;
    scrubMermaidSvgAttributes(svg);
    const anchors = svg.querySelectorAll('a');
    expect(anchors[0].hasAttribute('href')).toBe(false);
    expect(anchors[1].hasAttribute('href')).toBe(false);
  });

  it('strips vbscript: URLs', () => {
    document.body.innerHTML = '<svg><a href="vbscript:bad()"></a></svg>';
    const svg = document.body.querySelector('svg')!;
    scrubMermaidSvgAttributes(svg);
    expect(svg.querySelector('a')!.hasAttribute('href')).toBe(false);
  });

  it('preserves safe attributes (href, fill, viewBox, etc.)', () => {
    document.body.innerHTML =
      '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
      '<a href="https://example.com"></a>' +
      '<rect fill="red" width="5"/>' +
      '</svg>';
    const svg = document.body.querySelector('svg')!;
    scrubMermaidSvgAttributes(svg);
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(svg.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('red');
    expect(svg.querySelector('rect')!.getAttribute('width')).toBe('5');
  });

  it('does not match attributes that merely contain "on" in the middle', () => {
    document.body.innerHTML = '<svg><rect font-size="12"/></svg>';
    const svg = document.body.querySelector('svg')!;
    scrubMermaidSvgAttributes(svg);
    // "font-size" doesn't start with "on" — safe.
    expect(svg.querySelector('rect')!.getAttribute('font-size')).toBe('12');
  });
});

describe('safelySetSvgContent', () => {
  it('parses an SVG string and replaces wrapper children', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<p>old content</p>';
    document.body.appendChild(wrapper);

    safelySetSvgContent(
      wrapper,
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg>',
    );

    expect(wrapper.children).toHaveLength(1);
    expect(wrapper.firstElementChild!.tagName.toLowerCase()).toBe('svg');
    expect(wrapper.firstElementChild!.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(wrapper.querySelector('circle')).not.toBeNull();
    expect(wrapper.querySelector('p')).toBeNull();
  });

  it('strips on* handlers from the parsed SVG before insertion', () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);

    safelySetSvgContent(
      wrapper,
      '<svg onload="alert(1)"><g onclick="bad()"></g></svg>',
    );

    expect(wrapper.querySelector('svg')!.hasAttribute('onload')).toBe(false);
    expect(wrapper.querySelector('g')!.hasAttribute('onclick')).toBe(false);
  });

  it('strips javascript: URLs from the parsed SVG before insertion', () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);

    safelySetSvgContent(
      wrapper,
      '<svg><a href="javascript:evil()"><rect/></a></svg>',
    );

    expect(wrapper.querySelector('a')!.hasAttribute('href')).toBe(false);
  });

  it('throws when the input has no <svg> root', () => {
    const wrapper = document.createElement('div');
    document.body.appendChild(wrapper);

    expect(() => safelySetSvgContent(wrapper, '<div>not svg</div>')).toThrow(
      /no <svg> root found/,
    );
  });
});
