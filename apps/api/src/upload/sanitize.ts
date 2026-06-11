import sanitizeHtml from 'sanitize-html';

// SVG namespace is case-sensitive (viewBox != viewbox, linearGradient !=
// lineargradient). We disable parser lowercasing and list SVG tag/attribute
// names in their canonical camelCase. HTML authors are expected to use
// lowercase, which matches browser behaviour regardless.
const PARSER_OPTIONS = {
  lowerCaseTags: false,
  lowerCaseAttributeNames: false,
};

const SVG_TAGS = [
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'marker',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'pattern', 'filter',
];

const SVG_PRESENTATION_ATTRS = [
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'opacity', 'transform',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'letter-spacing', 'word-spacing',
  'clip-path', 'mask', 'filter',
  'marker-start', 'marker-mid', 'marker-end',
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    // Document structure — preserved so theming attrs on <html>/<body> and
    // inline <style>/<meta charset> survive the upload.
    'html', 'head', 'body', 'meta', 'title', 'style',
    // Block + inline
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
    'a', 'img',
    'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav',
    'figure', 'figcaption', 'details', 'summary',
    'canvas',
    ...SVG_TAGS,
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    html: ['lang', 'dir'],
    // Note: <meta http-equiv> is intentionally NOT listed. sanitize-html
    // strips unlisted attributes, so http-equiv="refresh" cannot survive.
    meta: ['charset', 'name', 'content'],
    style: ['type', 'media'],
    svg: ['viewBox', 'xmlns', 'preserveAspectRatio', 'width', 'height',
          'role', 'aria-label', 'aria-labelledby', 'aria-describedby'],
    path: ['d', 'pathLength'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    line: ['x1', 'y1', 'x2', 'y2'],
    polyline: ['points'],
    polygon: ['points'],
    text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
    tspan: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
    marker: ['markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY',
             'orient', 'viewBox'],
    linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
    radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    clipPath: ['clipPathUnits'],
    mask: ['maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height'],
    pattern: ['patternUnits', 'patternContentUnits', 'patternTransform', 'x', 'y', 'width', 'height', 'viewBox'],
    filter: ['x', 'y', 'width', 'height', 'filterUnits', 'primitiveUnits'],
    '*': [
      'class', 'id', 'style', 'role', 'tabindex',
      'data-*', 'aria-*',
      ...SVG_PRESENTATION_ATTRS,
    ],
  },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowedSchemesByTag: {
    img: ['https', 'http', 'data'],
  },
  // <style> is listed above; sanitize-html flags it as "vulnerable" by
  // default. We add an explicit CSS scrub below (scrubStyleBlocks) for the
  // patterns that matter — expression(), url(javascript:), behavior,
  // -moz-binding, @import.
  allowVulnerableTags: true,
  parser: PARSER_OPTIONS,
};

// Patterns we strip from <style> contents. sanitize-html does not parse CSS,
// so dangerous constructs inside a <style> tag would otherwise pass through.
const CSS_SCRUB_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /expression\s*\(/gi, replacement: '/*removed*/(' },
  { pattern: /behavior\s*:[^;}]*/gi, replacement: '/*removed*/' },
  { pattern: /-moz-binding\s*:[^;}]*/gi, replacement: '/*removed*/' },
  { pattern: /url\s*\(\s*(['"]?)\s*(?:javascript|vbscript)\s*:[^)]*\)/gi, replacement: 'url(about:blank)' },
  { pattern: /@import\b[^;]*;?/gi, replacement: '/*removed*/' },
];

function scrubCssText(css: string): string {
  let scrubbed = css;
  for (const { pattern, replacement } of CSS_SCRUB_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

// Replace the contents of every <style>...</style> block with a CSS-scrubbed
// version. Runs on already-sanitized output so the only <style> blocks
// present are ones we allowed.
function scrubStyleBlocks(html: string): string {
  return html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attrs, body) => {
    return `<style${attrs}>${scrubCssText(body)}</style>`;
  });
}

export function sanitizeUploadedHtml(rawHtml: string): string {
  const sanitized = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
  return scrubStyleBlocks(sanitized);
}
