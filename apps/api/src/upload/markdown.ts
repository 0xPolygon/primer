import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import taskLists from 'markdown-it-task-lists';

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
