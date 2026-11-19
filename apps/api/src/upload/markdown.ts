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

/** The one Markdown tokenizer of live imports. Raw HTML is tokenized (so an
 *  import can keep it, verbatim, in a source block) but never rendered into a
 *  page: source previews are sanitized and shown in a script-less frame. */
export const markdownTokenizer = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
}).use(taskLists, { label: false });

// SECURITY: gray-matter selects its parse engine from the language token after
// the opening front-matter fence (`---js`, `---json`, …). Its built-in
// `javascript` engine runs `eval()` on the block, so an uploaded `.md` that
// opens with `---js` would execute arbitrary JavaScript with the API process's
// privileges at upload time — remote code execution reachable by any
// authenticated uploader. gray-matter's advertised `eval: false` option is not
// implemented (4.0.3), so we replace the JS engine with a parser that returns
// no data. Only the safe built-in engines (`yaml`, `json`) remain; any other
// language is unregistered and throws. Normal `---` / `---yaml` front-matter
// and `---json` keep working. Do not remove this override without a replacement
// that keeps `eval` out of the upload path.
const FRONTMATTER_ENGINES = {
  javascript: {
    parse: () => ({}),
  },
};

/** Splits YAML/JSON front matter from a Markdown file: the raw front matter
 *  text exactly as written (fences included, '' when there is none), its
 *  parsed data, and the body after it. `frontMatter + body === input`. */
export function splitFrontMatter(input: string): { frontMatter: string; data: Record<string, unknown>; body: string } {
  const parsed = matter(input, { engines: FRONTMATTER_ENGINES });
  if (!input.endsWith(parsed.content)) throw new Error('front matter could not be separated from the body');
  return {
    frontMatter: input.slice(0, input.length - parsed.content.length),
    data: { ...parsed.data },
    body: parsed.content,
  };
}

export function markdownToHtml(input: string): MarkdownConversionResult {
  const parsed = matter(input, { engines: FRONTMATTER_ENGINES });
  const body = parsed.content.trim();
  const bodyIsEmpty = body.length === 0;

  const rendered = bodyIsEmpty ? '' : md.render(parsed.content);

  const fmTitle =
    typeof parsed.data.title === 'string' && parsed.data.title.trim().length > 0
      ? parsed.data.title.trim()
      : null;

  return { html: wrapArticle(rendered), frontmatterTitle: fmTitle, bodyIsEmpty };
}

/** Plain text (`.txt`) as escaped paragraphs in the Markdown page shell:
 *  blank lines split paragraphs, single newlines become line breaks. */
export function textToHtml(input: string): { html: string; bodyIsEmpty: boolean } {
  const paragraphs = input
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${md.utils.escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return { html: wrapArticle(paragraphs.join('')), bodyIsEmpty: paragraphs.length === 0 };
}

function wrapArticle(body: string): string {
  return (
    '<!doctype html>' +
    '<html data-theme="light">' +
    '<head>' +
    '<meta charset="utf-8">' +
    `<style>${MARKDOWN_STYLESHEET}</style>` +
    '</head>' +
    '<body>' +
    `<article class="primer-md">${body}</article>` +
    '</body>' +
    '</html>'
  );
}
