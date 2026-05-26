import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import taskLists from 'markdown-it-task-lists';
import { MARKDOWN_STYLESHEET } from './markdownStylesheet.ts';

export interface MarkdownConversionResult {
  /** Full <!doctype html>…</html> document with inline stylesheet. */
  html: string;
  /** Title pulled from YAML frontmatter, if present and a non-empty string. */
  frontmatterTitle: string | null;
  /** True when the Markdown body (post-frontmatter) is whitespace-only.
   *  The caller decides how to handle (we map it to parse_failed). */
  bodyIsEmpty: boolean;
}

const md = new MarkdownIt({
  html: false,        // raw HTML in source becomes text, not tags
  linkify: true,      // bare URLs autolink
  breaks: false,      // single newlines stay as spaces (CommonMark default)
  typographer: false, // no smart-quote rewriting
}).use(taskLists, { label: false });

export function markdownToHtml(input: string): MarkdownConversionResult {
  const parsed = matter(input);
  const body = parsed.content.trim();
  const bodyIsEmpty = body.length === 0;

  const rendered = bodyIsEmpty ? '' : md.render(parsed.content);

  const fmTitle =
    typeof parsed.data.title === 'string' && parsed.data.title.trim().length > 0
      ? parsed.data.title.trim()
      : null;

  const html =
    '<!doctype html>' +
    '<html data-theme="light">' +
    '<head>' +
    '<meta charset="utf-8">' +
    `<style>${MARKDOWN_STYLESHEET}</style>` +
    '</head>' +
    '<body>' +
    `<article class="primer-md">${rendered}</article>` +
    '</body>' +
    '</html>';

  return { html, frontmatterTitle: fmTitle, bodyIsEmpty };
}
