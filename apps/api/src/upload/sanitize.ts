import sanitizeHtml from 'sanitize-html';

// SVG namespace is case-sensitive (viewBox != viewbox, linearGradient !=
// lineargradient). We disable parser lowercasing and list SVG tag/attribute
// names in their canonical camelCase. HTML authors are expected to use
// lowercase, which matches browser behaviour regardless.
const PARSER_OPTIONS = {
  lowerCaseTags: false,
  lowerCaseAttributeNames: false,
};

export const SVG_TAGS = [
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'marker', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop',
  'clipPath', 'mask', 'pattern', 'filter',
];

const PRIMER_TAGS = ['primer-table', 'primer-code', 'primer-mermaid', 'primer-math'];

export const SVG_PRESENTATION_ATTRS = [
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

// Per-tag SVG attributes (geometry and references). Widgets reuse these lists
// (widgets/serialize.ts) without the sanitizer's `'*'` row.
export const SVG_TAG_ATTRS: Record<string, string[]> = {
  svg: ['viewBox', 'xmlns', 'preserveAspectRatio', 'width', 'height',
        'role', 'aria-label', 'aria-labelledby', 'aria-describedby'],
  use: ['href', 'x', 'y', 'width', 'height'],
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
};

// Threat model: uploaded HTML executes inside ArtifactIframe's
// `sandbox="allow-scripts allow-forms allow-modals allow-downloads"`
// (no `allow-same-origin`), so any
// script that runs is on an opaque origin — no access to Primer cookies,
// storage, parent DOM, or the app's auth surface. The artifact CSP also
// pins `connect-src 'none'` and `form-action 'none'`, so even hostile JS
// inside the sandbox cannot exfiltrate over the network or post forms.
// We therefore allow <script> and inline on* event handlers so uploaded
// dashboards remain interactive. We still strip the things the sandbox
// does NOT defang: <iframe>/<object>/<embed> (could nest non-sandboxed
// content via document.write), <form> (UI deception), javascript: hrefs
// (defense-in-depth against URL-based injection), and <meta http-equiv>
// (no legitimate use here).
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    // Document structure — preserved so theming attrs on <html>/<body> and
    // inline <style>/<meta charset> survive the upload.
    'html', 'head', 'body', 'meta', 'title', 'style', 'script',
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
    // Form controls — kept so interactive dashboards (selects/inputs/buttons
    // wired up via addEventListener) work. <form> itself is intentionally
    // omitted; CSP `form-action 'none'` blocks submissions either way and
    // dashboards drive these via JS, not native form posts.
    'button', 'input', 'select', 'option', 'optgroup', 'textarea',
    'label', 'fieldset', 'legend',
    ...SVG_TAGS,
    // Primer blocks inside pages (page/embeds.ts): rendered read-only from the
    // document's block state and edited in Primer's own window.
    ...PRIMER_TAGS,
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    html: ['lang', 'dir'],
    // Note: <meta http-equiv> is intentionally NOT listed. sanitize-html
    // strips unlisted attributes, so http-equiv="refresh" cannot survive.
    meta: ['charset', 'name', 'content'],
    style: ['type', 'media'],
    script: ['type', 'src', 'async', 'defer', 'integrity', 'crossorigin', 'nonce'],
    button: ['type', 'name', 'value', 'disabled', 'autofocus'],
    input: [
      'type', 'name', 'value', 'placeholder', 'disabled', 'readonly', 'checked',
      'min', 'max', 'step', 'pattern', 'required', 'autocomplete', 'autofocus',
      'list', 'maxlength', 'minlength', 'size', 'multiple', 'accept',
    ],
    select: ['name', 'multiple', 'disabled', 'size', 'required', 'autofocus'],
    option: ['value', 'selected', 'disabled', 'label'],
    optgroup: ['label', 'disabled'],
    textarea: [
      'name', 'rows', 'cols', 'placeholder', 'disabled', 'readonly',
      'required', 'maxlength', 'minlength', 'wrap', 'autofocus',
    ],
    label: ['for'],
    ...Object.fromEntries(PRIMER_TAGS.map((tag) => [tag, ['lang']])),
    fieldset: ['disabled', 'name'],
    ...SVG_TAG_ATTRS,
    '*': [
      'class', 'id', 'style', 'role', 'tabindex',
      'data-*', 'aria-*',
      // Inline event handlers — allowed because the iframe sandbox isolates
      // any JS they trigger. See threat-model comment above SANITIZE_OPTIONS.
      'on*',
      ...SVG_PRESENTATION_ATTRS,
    ],
  },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowedSchemesByTag: {
    img: ['https', 'http', 'data'],
  },
  // <use> may only reference same-document fragments. An external href
  // (https://…/sprite.svg#x or a relative path) would pull remote SVG
  // into the artifact, which the sandbox does not defang. We normalize
  // legacy xlink:href to href, strip anything that is not a "#fragment",
  // and drop the element entirely when no valid href remains.
  transformTags: {
    use: (tagName, attribs) => {
      const href = attribs.href ?? attribs['xlink:href'] ?? '';
      const kept: Record<string, string> = {};
      if (href.startsWith('#')) kept.href = href;
      for (const k of ['x', 'y', 'width', 'height', 'class', 'id', 'style']) {
        if (attribs[k] !== undefined) kept[k] = attribs[k];
      }
      return { tagName: 'use', attribs: kept };
    },
  },
  // Runs after transformTags, so a surviving <use> can only carry the
  // normalized `href` — xlink:href never reaches this point.
  exclusiveFilter: (frame) =>
    frame.tag === 'use' && !(frame.attribs.href ?? '').startsWith('#'),
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
