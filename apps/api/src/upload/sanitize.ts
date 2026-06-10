import sanitizeHtml from 'sanitize-html';

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
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
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'title', 'width', 'height', 'loading'],
    '*': ['class', 'id', 'style'],
  },
  allowedSchemes: ['https', 'http', 'mailto'],
  allowedSchemesByTag: {
    img: ['https', 'http', 'data'],
  },
  // sanitize-html strips unlisted attributes (including all on* handlers)
  // and unlisted tags (script, form, object, embed, iframe, meta, etc.).
};

export function sanitizeUploadedHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml, SANITIZE_OPTIONS);
}
