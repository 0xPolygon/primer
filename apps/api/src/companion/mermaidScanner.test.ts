// apps/api/src/companion/mermaidScanner.test.ts
//
// Mirror tests for the Mermaid detection logic in v1.js. The companion is
// plain ES2020 served verbatim into the iframe, so the helpers below are a
// self-contained mirror of the selectors and skip-condition checks. If you
// change v1.js, mirror the change here (and vice versa).
//
// Pattern lifted from textRangePosition.test.ts.

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

// ── Mirror of v1.js logic — keep in sync ──────────────────────────────

function findMermaidBlocks(doc: Document): HTMLElement[] {
  const matches = doc.querySelectorAll<HTMLElement>(
    'pre > code.language-mermaid, pre.mermaid',
  );
  const out: HTMLElement[] = [];
  for (const el of matches) {
    // Resolve to the block root (always the <pre>).
    const root = el.tagName === 'PRE' ? el : (el.parentElement as HTMLElement);
    if (!root || root.tagName !== 'PRE') continue;
    // Skip blocks that already contain a rendered SVG.
    if (root.querySelector(':scope > svg, :scope > div > svg')) continue;
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

function documentHasMermaidBootstrap(doc: Document, win: Window): boolean {
  if ((win as unknown as { mermaid?: unknown }).mermaid !== undefined) return true;
  const scripts = doc.querySelectorAll('script');
  for (const s of scripts) {
    const src = s.getAttribute('src') ?? '';
    if (src && /mermaid/i.test(src)) return true;
    const text = s.textContent ?? '';
    if (text.includes('mermaid.initialize') || text.includes('mermaid.run')) {
      return true;
    }
  }
  return false;
}

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('findMermaidBlocks', () => {
  it('matches the markdown-it fenced pattern', () => {
    document.body.innerHTML =
      '<pre><code class="language-mermaid">graph TD; A-->B;</code></pre>';
    const blocks = findMermaidBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tagName).toBe('PRE');
    expect(blocks[0].textContent).toContain('graph TD');
  });

  it('matches the canonical pre.mermaid pattern', () => {
    document.body.innerHTML =
      '<pre class="mermaid">sequenceDiagram; A->>B: hi</pre>';
    const blocks = findMermaidBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].classList.contains('mermaid')).toBe(true);
  });

  it('matches both patterns at once and deduplicates', () => {
    document.body.innerHTML =
      '<pre><code class="language-mermaid">A</code></pre>' +
      '<pre class="mermaid">B</pre>';
    expect(findMermaidBlocks(document)).toHaveLength(2);
  });

  it('does NOT match <div class="mermaid"> (false-positive guard)', () => {
    document.body.innerHTML = '<div class="mermaid">graph TD; A-->B;</div>';
    expect(findMermaidBlocks(document)).toHaveLength(0);
  });

  it('does NOT match inline <code class="language-mermaid"> outside <pre>', () => {
    document.body.innerHTML =
      '<p>see <code class="language-mermaid">graph LR</code></p>';
    expect(findMermaidBlocks(document)).toHaveLength(0);
  });

  it('skips blocks that already contain an <svg> (pre-rendered)', () => {
    document.body.innerHTML =
      '<pre class="mermaid"><svg></svg></pre>' +
      '<pre class="mermaid">graph TD; A-->B;</pre>';
    const blocks = findMermaidBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toContain('graph TD');
  });

  it('returns empty list when no blocks match', () => {
    document.body.innerHTML = '<p>no diagrams here</p>';
    expect(findMermaidBlocks(document)).toEqual([]);
  });
});

describe('documentHasMermaidBootstrap', () => {
  it('detects a <script src> referencing mermaid (case-insensitive)', () => {
    document.body.innerHTML =
      '<script src="https://cdn.example.com/Mermaid.min.js"></script>';
    expect(documentHasMermaidBootstrap(document, window)).toBe(true);
  });

  it('detects inline mermaid.initialize calls', () => {
    document.body.innerHTML =
      '<script>mermaid.initialize({ startOnLoad: true });</script>';
    expect(documentHasMermaidBootstrap(document, window)).toBe(true);
  });

  it('detects inline mermaid.run calls', () => {
    document.body.innerHTML = '<script>mermaid.run();</script>';
    expect(documentHasMermaidBootstrap(document, window)).toBe(true);
  });

  it('detects a pre-defined window.mermaid', () => {
    const fakeWin = { mermaid: {} } as unknown as Window;
    expect(documentHasMermaidBootstrap(document, fakeWin)).toBe(true);
  });

  it('returns false when no Mermaid bootstrap is present', () => {
    document.body.innerHTML =
      '<script src="/companion/v1.js"></script>' +
      '<script>console.log("hi");</script>';
    expect(documentHasMermaidBootstrap(document, window)).toBe(false);
  });
});
