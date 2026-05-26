# Primer Copy & Upload Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Markdown as an I/O format on both ends of Primer — accept `.md` / `.markdown` uploads (server-side GFM conversion, default stylesheet, parent-driven theme via the companion), and let viewers copy a version's comments to the clipboard as Markdown alongside the existing download. Reorganize the document header's actions into a single three-dot menu.

**Architecture:** Two largely independent changes wired in the same plan. Upload-side: an additive `markdownToHtml` step (markdown-it GFM + gray-matter + an inlined `<style>` block) runs before the existing `transformHtml` pipeline; everything downstream is unchanged because the stored artifact is HTML. Companion-side: a new `theme` field on `init` and a `theme_changed` outbound message let the parent drive the artifact's `<html data-theme>` so the MD stylesheet tracks the app theme. Client-side: a small clipboard helper feeds the existing `formatThreadsAsMarkdown` to `navigator.clipboard.writeText`; the three-dot menu becomes the home for Copy, Download, and Delete.

**Tech Stack:** Hono (Node 24) + Drizzle + parse5 on the API; React 19 + Vite + Tailwind 4 on the web. TypeScript everywhere. Vitest (node environment, pure-logic tests only — no JSDOM, no React Testing Library). New deps on the API only: `markdown-it`, `markdown-it-task-lists`, `gray-matter`. Companion script is plain ES2020 JS executing inside the artifact iframe.

**Spec:** `docs/superpowers/specs/2026-05-26-primer-markdown-copy-upload-design.md`

**Important constraints from project memory:**
- Use `pnpm`, not `npm`.
- Never `git push` without explicit instruction in the turn — `master` auto-deploys to Railway. Every task ends with a commit; pushing is the user's call.
- Don't skip git hooks (`--no-verify`) or signing.
- `pnpm-workspace.yaml` enforces `minimumReleaseAge: 14 days` and `allowBuilds: { esbuild: true }`. New deps must clear the 14-day gate; none of the three deps in this plan need a postinstall script.
- NixOS dev box: before running `pnpm install`, ensure both `pnpm` and the Nix-store `node` are on `PATH`. Postinstalls fail otherwise.

---

## File map

**New (API):**
- `apps/api/src/upload/markdownStylesheet.ts` — exported constant: the inline CSS string baked into MD artifacts.
- `apps/api/src/upload/markdown.ts` — `markdownToHtml(input)` conversion module.
- `apps/api/src/upload/markdown.test.ts` — unit tests for the conversion.
- `apps/api/src/upload/__fixtures__/sample.md` — a representative GFM sample used by tests and manual visual checks.

**New (Web):**
- `apps/web/src/lib/frontmatterTitle.ts` — pure parser: pulls a `title` value out of YAML-ish frontmatter at the head of an MD slice.
- `apps/web/src/lib/frontmatterTitle.test.ts` — tests for the parser.
- `apps/web/src/lib/clipboardCopy.ts` — `copyText(text)` helper with `navigator.clipboard` primary path and `execCommand` fallback.
- `apps/web/src/lib/clipboardCopy.test.ts` — tests for the helper (pure logic + injected adapters).
- `apps/web/src/lib/documentActionsMenu.ts` — pure helper computing which menu items to show.
- `apps/web/src/lib/documentActionsMenu.test.ts` — tests for that helper.

**Modified (API):**
- `apps/api/package.json` — add three deps.
- `apps/api/src/upload/validate.ts` — accept `.md` / `.markdown` extensions and additional content types.
- `apps/api/src/upload/validate.test.ts` — extend.
- `apps/api/src/routes/upload.ts` — branch through `markdownToHtml` before `transformHtml` for MD files.
- `apps/api/src/routes/upload.test.ts` — extend with `.md` end-to-end test.
- `apps/api/src/companion/v1.js` — apply `data-theme` on init and `theme_changed`.

**Modified (Shared):**
- `packages/shared/src/companion-protocol.ts` — add `theme` to `MsgInit`, new `MsgThemeChanged` outbound variant, parser update is **not needed** for outbound messages (the companion validates inbound, not outbound — see Task 6 details).

**Modified (Web):**
- `apps/web/src/components/FileDropZone.tsx` — accept `.html` / `.md` / `.markdown`; updated copy.
- `apps/web/src/routes/upload.tsx` — wire frontmatter prefill on `.md` file pick.
- `apps/web/src/components/ArtifactIframe.tsx` — accept `theme` prop, include in init, post `theme_changed` on change.
- `apps/web/src/routes/document.tsx` — pass effective theme into `ArtifactIframe`; remove the standalone Export button; expand the three-dot menu (visible to all users; mobile-reachable).

---

### Task 1: Add Markdown conversion deps

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml` (regenerated)

- [ ] **Step 1: Add deps to `apps/api/package.json`**

In the `dependencies` block of `apps/api/package.json`, add (keeping alphabetical order):

```json
    "gray-matter": "^4.0.3",
    "markdown-it": "^14.1.0",
    "markdown-it-task-lists": "^2.1.1",
```

These three packages are all stable and well past the 14-day release-age gate. None ship a postinstall script.

- [ ] **Step 2: Install with frozen lockfile-then-update**

From the repo root:

```
pnpm install
```

Expected: lockfile updates with the three new packages plus their transitive deps. No `ERR_PNPM_NO_MATURE_MATCHING_VERSION` (release age is satisfied). No `pnpm approve-builds` prompt (no new postinstall scripts).

If pnpm prompts to approve a new build script, **stop and investigate** — do not approve sight-unseen. Bring it back to the user.

- [ ] **Step 3: Verify audit still clean**

```
pnpm audit --audit-level=high
```

Expected: no high-severity findings.

- [ ] **Step 4: Verify the existing build still works**

```
pnpm typecheck && pnpm test
```

Expected: PASS. Nothing imports the new deps yet, so this just confirms the install was clean.

- [ ] **Step 5: Commit**

```
git add apps/api/package.json pnpm-lock.yaml
git commit -m "build(api): add markdown-it, markdown-it-task-lists, gray-matter"
```

---

### Task 2: Create the Markdown stylesheet module

**Files:**
- Create: `apps/api/src/upload/markdownStylesheet.ts`

- [ ] **Step 1: Create the module**

Create `apps/api/src/upload/markdownStylesheet.ts` with:

```ts
/**
 * Inline stylesheet baked into Markdown-uploaded artifacts.
 *
 * Why inline (not served): the artifact iframe is sandbox="allow-scripts
 * allow-forms" (no allow-same-origin) and CSP `connect-src 'none'`, so an
 * external stylesheet would require widening CSP. Inline <style> is already
 * permitted via `style-src 'unsafe-inline'`. The file is small enough that
 * inlining is cheaper than the cross-origin plumbing.
 *
 * Theming: CSS variables under :root and [data-theme="dark"]. The companion
 * script sets `document.documentElement.dataset.theme` from a parent
 * postMessage; without the companion, the document stays light.
 */
export const MARKDOWN_STYLESHEET = `
:root, html[data-theme="light"] {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --code-bg: #f3f4f6;
  --link: #2563eb;
}
html[data-theme="dark"] {
  --bg: #0a0a0a;
  --fg: #e5e7eb;
  --muted: #9ca3af;
  --border: #374151;
  --code-bg: #1f2937;
  --link: #60a5fa;
}

html, body {
  background: var(--bg);
  color: var(--fg);
  margin: 0;
}
body {
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.primer-md {
  max-width: 760px;
  margin: 0 auto;
  padding: 48px 24px;
}
.primer-md h1, .primer-md h2, .primer-md h3, .primer-md h4, .primer-md h5, .primer-md h6 {
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
  font-weight: 600;
}
.primer-md h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.primer-md h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.primer-md h3 { font-size: 1.25em; }
.primer-md h4 { font-size: 1em; }
.primer-md h5 { font-size: 0.9em; color: var(--muted); }
.primer-md h6 { font-size: 0.85em; color: var(--muted); }
.primer-md p { margin: 0 0 1em; }
.primer-md a { color: var(--link); text-decoration: none; }
.primer-md a:hover { text-decoration: underline; }
.primer-md ul, .primer-md ol { margin: 0 0 1em; padding-left: 1.5em; }
.primer-md li { margin: 0.25em 0; }
.primer-md li > p { margin: 0.25em 0; }
.primer-md blockquote {
  margin: 0 0 1em;
  padding: 0 1em;
  border-left: 4px solid var(--border);
  color: var(--muted);
}
.primer-md hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 2em 0;
}
.primer-md code {
  font: 0.9em/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--code-bg);
  padding: 0.1em 0.35em;
  border-radius: 3px;
}
.primer-md pre {
  background: var(--code-bg);
  padding: 1em;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0 0 1em;
}
.primer-md pre > code {
  background: transparent;
  padding: 0;
  font-size: 0.9em;
  line-height: 1.5;
}
.primer-md table {
  border-collapse: collapse;
  margin: 0 0 1em;
  width: 100%;
}
.primer-md th, .primer-md td {
  border: 1px solid var(--border);
  padding: 0.4em 0.7em;
  text-align: left;
}
.primer-md th { background: var(--code-bg); font-weight: 600; }
.primer-md img { max-width: 100%; height: auto; }
.primer-md del { color: var(--muted); }
.primer-md input[type="checkbox"] {
  margin-right: 0.4em;
  vertical-align: middle;
}
.primer-md ul.contains-task-list { padding-left: 0; list-style: none; }
.primer-md .task-list-item { padding-left: 0; }
`.trim();
```

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/api/src/upload/markdownStylesheet.ts
git commit -m "feat(api): inline stylesheet module for Markdown artifacts"
```

---

### Task 3: Markdown conversion module (TDD)

**Files:**
- Create: `apps/api/src/upload/markdown.ts`
- Create: `apps/api/src/upload/markdown.test.ts`
- Create: `apps/api/src/upload/__fixtures__/sample.md`

- [ ] **Step 1: Write the failing tests first**

Create `apps/api/src/upload/markdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdown.ts';
import { MARKDOWN_STYLESHEET } from './markdownStylesheet.ts';

describe('markdownToHtml', () => {
  it('returns a full HTML document with body content and stylesheet', () => {
    const r = markdownToHtml('# Hello\n\nWorld.');
    expect(r.html.startsWith('<!doctype html>')).toBe(true);
    expect(r.html).toContain(MARKDOWN_STYLESHEET);
    expect(r.html).toContain('<h1>Hello</h1>');
    expect(r.html).toContain('<p>World.</p>');
    expect(r.html).toContain('data-theme="light"');
    expect(r.html).toContain('class="primer-md"');
  });

  it('renders GFM tables', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n';
    const r = markdownToHtml(md);
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<th>A</th>');
    expect(r.html).toContain('<td>1</td>');
  });

  it('renders GFM strikethrough', () => {
    const r = markdownToHtml('hello ~~world~~');
    expect(r.html).toContain('<s>world</s>');
  });

  it('renders task list checkboxes', () => {
    const r = markdownToHtml('- [ ] todo\n- [x] done\n');
    expect(r.html).toContain('type="checkbox"');
    expect(r.html).toContain('checked');
    expect(r.html).toContain('contains-task-list');
  });

  it('autolinks bare URLs', () => {
    const r = markdownToHtml('See https://example.com for details.');
    expect(r.html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('renders fenced code blocks', () => {
    const r = markdownToHtml('```\nconst x = 1;\n```\n');
    expect(r.html).toContain('<pre>');
    expect(r.html).toContain('const x = 1;');
  });

  it('escapes raw HTML in the source (html: false enforced)', () => {
    const r = markdownToHtml('Hello <script>alert(1)</script>\n');
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('strips frontmatter from output and extracts title', () => {
    const md = '---\ntitle: My Report\n---\n\n# Body\n';
    const r = markdownToHtml(md);
    expect(r.frontmatterTitle).toBe('My Report');
    expect(r.html).not.toContain('title: My Report');
    expect(r.html).not.toContain('---');
    expect(r.html).toContain('<h1>Body</h1>');
  });

  it('returns frontmatterTitle null when no frontmatter present', () => {
    const r = markdownToHtml('# Just a heading\n');
    expect(r.frontmatterTitle).toBeNull();
  });

  it('returns frontmatterTitle null when title is missing from frontmatter', () => {
    const r = markdownToHtml('---\nauthor: someone\n---\n\n# Hi\n');
    expect(r.frontmatterTitle).toBeNull();
  });

  it('returns frontmatterTitle null when title is not a string', () => {
    const r = markdownToHtml('---\ntitle: 42\n---\n\n# Hi\n');
    expect(r.frontmatterTitle).toBeNull();
  });

  it('reports empty body when input is whitespace-only', () => {
    const r = markdownToHtml('   \n\n  ');
    expect(r.bodyIsEmpty).toBe(true);
  });

  it('reports empty body when only frontmatter is present', () => {
    const r = markdownToHtml('---\ntitle: x\n---\n');
    expect(r.bodyIsEmpty).toBe(true);
  });

  it('does not report empty body for a real document', () => {
    const r = markdownToHtml('Hello.');
    expect(r.bodyIsEmpty).toBe(false);
  });
});
```

- [ ] **Step 2: Create the fixture**

Create `apps/api/src/upload/__fixtures__/sample.md`:

```markdown
---
title: Sample Markdown Document
---

# Quarterly Report

A short paragraph with **bold**, *italic*, ~~strikethrough~~ and a [link](https://example.com).

## Table

| Region | Revenue |
|--------|---------|
| NA     | $1.2M   |
| EU     | $900K   |

## Tasks

- [ ] Draft the deck
- [x] Pull the numbers

## Code

```ts
function add(a: number, b: number): number {
  return a + b;
}
```
```

- [ ] **Step 3: Run the tests to verify they fail**

```
cd apps/api && pnpm test -- markdown.test
```

Expected: FAIL — `markdown.ts` doesn't exist yet.

- [ ] **Step 4: Implement `markdown.ts`**

Create `apps/api/src/upload/markdown.ts`:

> **Note on CJS interop:** All three deps (`markdown-it`, `markdown-it-task-lists`, `gray-matter`) are CJS modules consumed from an ESM workspace. Node's default-import interop should handle this cleanly. If `pnpm typecheck` complains about a missing default export from `markdown-it-task-lists`, swap that line to `import { default as taskLists } from 'markdown-it-task-lists';`.

```ts
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
```

- [ ] **Step 5: Re-run the tests**

```
cd apps/api && pnpm test -- markdown.test
```

Expected: PASS — all 13 cases.

- [ ] **Step 6: Sanity-check the fixture renders**

```
cd apps/api && node --input-type=module -e "import('./src/upload/markdown.ts').then(async m => { const fs = await import('node:fs/promises'); const src = await fs.readFile('./src/upload/__fixtures__/sample.md', 'utf8'); const r = m.markdownToHtml(src); console.log('title:', r.frontmatterTitle); console.log('bytes:', r.html.length); console.log(r.html.slice(0, 400)); })"
```

Expected: prints `title: Sample Markdown Document`, a 4–6 KB byte count, and the head of the document.

- [ ] **Step 7: Commit**

```
git add apps/api/src/upload/markdown.ts apps/api/src/upload/markdown.test.ts apps/api/src/upload/__fixtures__/sample.md
git commit -m "feat(api): markdownToHtml conversion (GFM, gray-matter frontmatter)"
```

---

### Task 4: Extend `validateUpload` to accept `.md` / `.markdown`

**Files:**
- Modify: `apps/api/src/upload/validate.ts`
- Modify: `apps/api/src/upload/validate.test.ts`

- [ ] **Step 1: Update the failing tests first**

In `apps/api/src/upload/validate.test.ts`, add the following test cases inside the `describe('validateUpload', ...)` block:

```ts
  it('accepts a .md filename', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'notes.md', contentType: 'text/markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a .markdown filename', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'notes.markdown', contentType: 'text/markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a .MD uppercase extension', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'NOTES.MD', contentType: 'text/markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts text/x-markdown content type', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'n.md', contentType: 'text/x-markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts missing content-type for .md', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'n.md', contentType: undefined },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a content-type/extension mismatch (.md with text/html)', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'n.md', contentType: 'text/html' },
      title: 't',
      description: undefined,
    });
    expect(r).toEqual({ ok: false, error: 'bad_content_type', message: expect.any(String) });
  });

  it('rejects an unsupported extension with the updated message', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'report.txt' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('bad_extension');
    expect(r.message).toContain('.html');
    expect(r.message).toContain('.md');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd apps/api && pnpm test -- validate.test
```

Expected: FAIL — the new cases fail because the validator only knows about `.html`.

- [ ] **Step 3: Update `validate.ts`**

Replace the extension and content-type checks at the bottom of `validateUpload` in `apps/api/src/upload/validate.ts`. The current block looks like:

```ts
  if (!input.file.filename.toLowerCase().endsWith('.html')) {
    return {
      ok: false,
      error: 'bad_extension',
      message: 'File must have a .html extension.',
    };
  }

  if (input.file.contentType !== undefined && input.file.contentType !== 'text/html') {
    return {
      ok: false,
      error: 'bad_content_type',
      message: `Unexpected content-type: ${input.file.contentType}.`,
    };
  }
```

Replace with:

```ts
  const lowerName = input.file.filename.toLowerCase();
  const isHtml = lowerName.endsWith('.html');
  const isMarkdown = lowerName.endsWith('.md') || lowerName.endsWith('.markdown');

  if (!isHtml && !isMarkdown) {
    return {
      ok: false,
      error: 'bad_extension',
      message: 'File must be .html, .md, or .markdown.',
    };
  }

  if (input.file.contentType !== undefined) {
    const ct = input.file.contentType;
    const htmlOk = isHtml && ct === 'text/html';
    const mdOk = isMarkdown && (ct === 'text/markdown' || ct === 'text/x-markdown' || ct === 'text/plain');
    if (!htmlOk && !mdOk) {
      return {
        ok: false,
        error: 'bad_content_type',
        message: `Unexpected content-type: ${ct}.`,
      };
    }
  }
```

Note: `text/plain` is accepted only for `.md`/`.markdown` because some browsers (notably older Firefox) advertise `.md` files as `text/plain`. `.html` with `text/plain` stays rejected.

- [ ] **Step 4: Re-run the tests**

```
cd apps/api && pnpm test -- validate.test
```

Expected: PASS (all old + new cases).

- [ ] **Step 5: Commit**

```
git add apps/api/src/upload/validate.ts apps/api/src/upload/validate.test.ts
git commit -m "feat(api): accept .md/.markdown uploads in validateUpload"
```

---

### Task 5: Wire Markdown conversion into the upload route

**Files:**
- Modify: `apps/api/src/routes/upload.ts`
- Modify: `apps/api/src/routes/upload.test.ts`

- [ ] **Step 1: Add the failing end-to-end test first**

In `apps/api/src/routes/upload.test.ts`, add a new `describe` block at the end of the file:

```ts
describe('POST /api/upload — markdown', () => {
  it('converts a .md upload to HTML and stores it as an artifact', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const md = '---\ntitle: From Frontmatter\n---\n\n# Hello\n\nWorld.';
      const fd = new FormData();
      fd.append('file', new Blob([md], { type: 'text/markdown' }), 'notes.md');
      fd.append('title', 'My Title'); // multipart title wins over frontmatter
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UploadResponse;

      const docRows = await db.select().from(documents).where(eq(documents.id, body.documentId));
      expect(docRows[0].title).toBe('My Title');

      const versionRows = await db.select().from(versions).where(eq(versions.id, body.versionId));
      const stream = await storage.get(versionRows[0].storageKey);
      const reader = stream.getReader();
      let combined = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        combined += new TextDecoder().decode(value);
      }
      expect(combined).toContain('<h1>Hello</h1>');
      expect(combined).toContain('<p>World.</p>');
      expect(combined).toContain('data-theme="light"');
      expect(combined).toContain('<script src="/companion/v1.js"'); // companion still injected
      expect(combined).not.toContain('---'); // frontmatter stripped
    });
  });

  it('rejects an empty-body markdown upload', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const md = '---\ntitle: empty\n---\n';
      const fd = new FormData();
      fd.append('file', new Blob([md], { type: 'text/markdown' }), 'empty.md');
      fd.append('title', 't');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'parse_failed' });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd apps/api && pnpm test -- upload.test
```

Expected: FAIL — `.md` currently never reaches the conversion step. The upload either fails at validation (the test loops through validation, succeeds because we just enabled `.md` extensions) and then `transformHtml` will try to parse raw Markdown as HTML — it'll succeed at parsing (parse5 is forgiving) but the output won't contain `<h1>Hello</h1>` because `# Hello` is literal text.

- [ ] **Step 3: Wire `markdownToHtml` into the upload route**

In `apps/api/src/routes/upload.ts`, update the imports:

```ts
import { validateUpload } from '../upload/validate.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { markdownToHtml } from '../upload/markdown.ts';
```

Then replace the section from `const text = ...` through `if (!transformed.ok) ...`. The current code is:

```ts
    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const transformed = transformHtml(text);
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }
```

Replace with:

```ts
    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const lowerName = validated.file.filename.toLowerCase();
    const isMarkdown =
      lowerName.endsWith('.md') || lowerName.endsWith('.markdown');

    let preparedHtml: string;
    if (isMarkdown) {
      let mdResult;
      try {
        mdResult = markdownToHtml(text);
      } catch (err) {
        return c.json(
          {
            error: 'parse_failed',
            message: `Markdown conversion failed: ${(err as Error).message}`,
          },
          400,
        );
      }
      if (mdResult.bodyIsEmpty) {
        return c.json(
          { error: 'parse_failed', message: 'Document body is empty.' },
          400,
        );
      }
      preparedHtml = mdResult.html;
    } else {
      preparedHtml = text;
    }

    const transformed = transformHtml(preparedHtml);
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }
```

- [ ] **Step 4: Re-run the tests**

```
cd apps/api && pnpm test -- upload.test
```

Expected: PASS — both new MD cases and all existing HTML cases.

- [ ] **Step 5: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```
git add apps/api/src/routes/upload.ts apps/api/src/routes/upload.test.ts
git commit -m "feat(api): convert .md/.markdown uploads to HTML in the upload pipeline"
```

---

### Task 6: Extend the shared protocol for theme

**Files:**
- Modify: `packages/shared/src/companion-protocol.ts`

- [ ] **Step 1: Read the file to confirm current shape**

The current `MsgInit` is at `packages/shared/src/companion-protocol.ts:33-37`:

```ts
export interface MsgInit {
  type: 'init';
  anchors: Anchor[];
}
```

The outbound message union is at line 60-66:

```ts
export type OutboundProtocolMessage =
  | MsgInit
  | MsgUpdateAnchors
  | MsgEnterPickMode
  | MsgExitPickMode
  | MsgSetFocusedAnchor
  | MsgRequestAnchorPositions;
```

The outbound messages (parent → companion) have no runtime parser — they're just types. The companion's port handler at `apps/api/src/companion/v1.js:159-193` validates inbound messages itself with a `switch (msg.type)` + a `default: log.warn('unknown inbound', msg.type)` — so an older companion seeing a `theme_changed` message will simply warn-and-continue. The new field `theme` on init is read only if `Array.isArray(incoming.anchors)` passes — extra fields are ignored. Backward compatibility is therefore already guaranteed by the existing companion.

- [ ] **Step 2: Update `MsgInit` and add `MsgThemeChanged`**

In `packages/shared/src/companion-protocol.ts`, replace the `MsgInit` definition:

```ts
export interface MsgInit {
  type: 'init';
  anchors: Anchor[];
}
```

with:

```ts
export type Theme = 'light' | 'dark';

export interface MsgInit {
  type: 'init';
  anchors: Anchor[];
  /** Parent's effective theme at iframe load. Companion sets
   *  document.documentElement.dataset.theme accordingly. Older companion
   *  snapshots ignore unknown init fields, so this is forward-compatible. */
  theme: Theme;
}

export interface MsgThemeChanged {
  type: 'theme_changed';
  theme: Theme;
}
```

Then update the `OutboundProtocolMessage` union to include the new message:

```ts
export type OutboundProtocolMessage =
  | MsgInit
  | MsgUpdateAnchors
  | MsgEnterPickMode
  | MsgExitPickMode
  | MsgSetFocusedAnchor
  | MsgRequestAnchorPositions
  | MsgThemeChanged;
```

- [ ] **Step 3: Typecheck (will reveal callers that need updates)**

```
pnpm typecheck
```

Expected: FAIL — `MsgInit` is constructed in `apps/web/src/components/ArtifactIframe.tsx:62` without a `theme` field. We'll fix that in Task 8. For now confirm the error is exactly the missing `theme` on the init object.

- [ ] **Step 4: Commit (broken state is OK — next tasks unblock)**

```
git add packages/shared/src/companion-protocol.ts
git commit -m "feat(shared): add theme to MsgInit + new MsgThemeChanged"
```

(The typecheck will be red until Task 8 lands. That's intentional — Tasks 7 and 8 must follow.)

---

### Task 7: Companion script applies `data-theme`

**Files:**
- Modify: `apps/api/src/companion/v1.js`

- [ ] **Step 1: Add theme application on init**

In `apps/api/src/companion/v1.js`, locate the init handler (around lines 126-153). Inside the block, after the existing `if (Array.isArray(incoming.anchors)) { … }` section and before `flushLogBuffer();`, add:

```js
    // Apply parent-provided theme. Field is optional for backward-compat with
    // parents that haven't been updated yet (they won't set anything).
    if (incoming.theme === 'light' || incoming.theme === 'dark') {
      try {
        document.documentElement.dataset.theme = incoming.theme;
      } catch (e) {
        // documentElement should always exist; defensive catch.
      }
    }
```

- [ ] **Step 2: Add a `theme_changed` case to the port message dispatcher**

In the same file, in the `switch (msg.type)` block of `onPortMessage` (around line 164), add a new case **before** the `default:` clause:

```js
      case 'theme_changed':
        if (msg.theme === 'light' || msg.theme === 'dark') {
          try {
            document.documentElement.dataset.theme = msg.theme;
          } catch (e) {
            // defensive
          }
        }
        break;
```

- [ ] **Step 3: Verify the change parses (no JS test infra for the companion)**

```
node --check apps/api/src/companion/v1.js
```

Expected: silent (script parses).

- [ ] **Step 4: Commit**

```
git add apps/api/src/companion/v1.js
git commit -m "feat(companion): apply parent theme via data-theme attribute"
```

---

### Task 8: `ArtifactIframe` passes theme into init and reacts to changes

**Files:**
- Modify: `apps/web/src/components/ArtifactIframe.tsx`

- [ ] **Step 1: Update the props interface and init payload**

In `apps/web/src/components/ArtifactIframe.tsx`, update the imports to include `Theme`:

```ts
import type {
  Anchor,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  Theme,
} from '@primer/shared';
```

Update the `Props` interface to add `theme`:

```ts
interface Props {
  src: string;
  anchors: Anchor[];
  theme: Theme;
  onMessage: (msg: InboundProtocolMessage) => void;
  registerSender?: (send: ((msg: OutboundProtocolMessage) => void) | null) => void;
}
```

Destructure `theme` in the component signature:

```ts
export function ArtifactIframe({ src, anchors, theme, onMessage, registerSender }: Props) {
```

Add a latest-value ref for theme alongside the others (around `anchorsRef`):

```ts
  const anchorsRef = useRef(anchors);
  const themeRef = useRef(theme);
  const onMessageRef = useRef(onMessage);
  const registerSenderRef = useRef(registerSender);
  useEffect(() => { anchorsRef.current = anchors; }, [anchors]);
  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { registerSenderRef.current = registerSender; }, [registerSender]);
```

In `sendInit`, update the init postMessage to include `theme`:

```ts
      iframe.contentWindow.postMessage(
        {
          type: 'init',
          anchors: anchorsRef.current,
          theme: themeRef.current,
        } satisfies OutboundProtocolMessage,
        '*',
        [channel.port2],
      );
```

- [ ] **Step 2: Add a `theme_changed` effect**

Add a new `useEffect` near the other effects in `ArtifactIframe`:

```ts
  // Push theme changes to the companion. The init handshake already carries
  // the current theme; this effect propagates subsequent toggles. The first
  // run (initial mount) is harmless — the companion may not yet be ready.
  useEffect(() => {
    portRef.current?.postMessage({ type: 'theme_changed', theme } satisfies OutboundProtocolMessage);
  }, [theme]);
```

This depends on the existing `portRef` already declared at the top of the component.

- [ ] **Step 3: Typecheck**

```
pnpm typecheck
```

Expected: FAIL — `DocumentPage` doesn't pass `theme` yet. Next task fixes that. Confirm the only remaining error is the missing prop at `routes/document.tsx`.

- [ ] **Step 4: Commit (still broken — DocumentPage update is next)**

```
git add apps/web/src/components/ArtifactIframe.tsx
git commit -m "feat(web): ArtifactIframe forwards theme to companion"
```

---

### Task 9: Wire effective theme through `DocumentPage`

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Pass `useTheme().effective` into `ArtifactIframe`**

In `apps/web/src/routes/document.tsx`, add the `useTheme` import near the other lib imports:

```ts
import { useTheme } from '../lib/useTheme.ts';
```

Inside `DocumentPage`, add the hook call (near `useMe()` for grouping):

```ts
  const me = useMe();
  const { effective: theme } = useTheme();
```

Update the `<ArtifactIframe>` element to pass `theme`. Currently:

```tsx
          <ArtifactIframe
            src={`/api/versions/${currentVersionId}/content`}
            anchors={anchorsForCompanion}
            onMessage={onMessage}
            registerSender={registerSender}
          />
```

Change to:

```tsx
          <ArtifactIframe
            src={`/api/versions/${currentVersionId}/content`}
            anchors={anchorsForCompanion}
            theme={theme}
            onMessage={onMessage}
            registerSender={registerSender}
          />
```

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: PASS — the chain from Tasks 6 → 7 → 8 → 9 is now complete.

- [ ] **Step 3: Run all tests**

```
pnpm test
```

Expected: PASS (no test exercises the iframe in a browser; this confirms nothing else broke).

- [ ] **Step 4: Manually verify in the dev server (one-time check)**

```
pnpm dev
```

Open a document in the browser. Toggle the theme via the UserMenu. The artifact iframe's inner `<html>` should now have `data-theme="dark"` / `data-theme="light"` matching. Inspect via browser devtools.

For an HTML artifact (no Markdown stylesheet consumer), the visible behavior is unchanged — the attribute is set but nothing styles off it. That's expected.

Stop the dev server.

- [ ] **Step 5: Commit**

```
git add apps/web/src/routes/document.tsx
git commit -m "feat(web): forward app theme to artifact companion"
```

---

### Task 10: `FileDropZone` accepts `.md` and `.markdown`

**Files:**
- Modify: `apps/web/src/components/FileDropZone.tsx`

- [ ] **Step 1: Update validation and copy in `FileDropZone`**

In `apps/web/src/components/FileDropZone.tsx`, update the `validate` function. The current implementation is:

```ts
function validate(file: File, maxBytes: number): string | null {
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith('.html')) return 'Only .html files are accepted.';
  if (file.size > maxBytes) {
    return `This file is ${formatSize(file.size)} — limit is ${formatSize(maxBytes)}.`;
  }
  return null;
}
```

Replace with:

```ts
function validate(file: File, maxBytes: number): string | null {
  const lowerName = file.name.toLowerCase();
  const ok =
    lowerName.endsWith('.html') ||
    lowerName.endsWith('.md') ||
    lowerName.endsWith('.markdown');
  if (!ok) return 'Only .html, .md, or .markdown files are accepted.';
  if (file.size > maxBytes) {
    return `This file is ${formatSize(file.size)} — limit is ${formatSize(maxBytes)}.`;
  }
  return null;
}
```

Update the `aria-label` (currently `"Upload HTML file"`):

```tsx
        aria-label="Upload HTML or Markdown file"
```

Update the dropzone copy line:

```tsx
              {isDragging ? 'Drop to attach' : 'Drop an HTML or Markdown file here, or click to browse'}
```

Update the size hint:

```tsx
            <p className="mt-1 text-xs text-neutral-500">.html / .md files up to {formatSize(maxBytes)}</p>
```

Update the `<input>`'s `accept` attribute:

```tsx
          accept=".html,text/html,.md,.markdown,text/markdown,text/x-markdown"
```

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/web/src/components/FileDropZone.tsx
git commit -m "feat(web): FileDropZone accepts .md/.markdown"
```

---

### Task 11: Frontmatter title prefill — pure parser (TDD)

**Files:**
- Create: `apps/web/src/lib/frontmatterTitle.ts`
- Create: `apps/web/src/lib/frontmatterTitle.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `apps/web/src/lib/frontmatterTitle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractFrontmatterTitle } from './frontmatterTitle.ts';

describe('extractFrontmatterTitle', () => {
  it('returns null when input has no frontmatter', () => {
    expect(extractFrontmatterTitle('# Just a heading\n')).toBeNull();
  });

  it('returns null when input does not start with ---', () => {
    expect(extractFrontmatterTitle('  ---\ntitle: x\n---\n')).toBeNull();
  });

  it('extracts a plain unquoted title', () => {
    const src = '---\ntitle: My Report\n---\n\n# body';
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });

  it('extracts a single-quoted title', () => {
    const src = "---\ntitle: 'My Report'\n---\n";
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });

  it('extracts a double-quoted title', () => {
    const src = '---\ntitle: "My Report"\n---\n';
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });

  it('preserves colons in unquoted values', () => {
    const src = '---\ntitle: Q3 Plan: revenue\n---\n';
    expect(extractFrontmatterTitle(src)).toBe('Q3 Plan: revenue');
  });

  it('returns null when there is no closing ---', () => {
    const src = '---\ntitle: x\n# body without delimiter';
    expect(extractFrontmatterTitle(src)).toBeNull();
  });

  it('returns null when title key is missing', () => {
    const src = '---\nauthor: someone\n---\n';
    expect(extractFrontmatterTitle(src)).toBeNull();
  });

  it('returns null when title is empty after trim', () => {
    const src = '---\ntitle:    \n---\n';
    expect(extractFrontmatterTitle(src)).toBeNull();
  });

  it('returns null when title looks numeric (we only handle strings)', () => {
    const src = '---\ntitle: 42\n---\n';
    // Numeric values get returned as the literal "42" — caller still treats
    // this as a string. That matches gray-matter's behavior closely enough
    // for prefill purposes.
    expect(extractFrontmatterTitle(src)).toBe('42');
  });

  it('handles other keys before title', () => {
    const src = '---\nauthor: a\ntitle: T\ntags: x\n---\n';
    expect(extractFrontmatterTitle(src)).toBe('T');
  });

  it('ignores lines after the closing ---', () => {
    const src = '---\ntitle: First\n---\ntitle: Second\n';
    expect(extractFrontmatterTitle(src)).toBe('First');
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\ntitle: My Report\r\n---\r\n';
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd apps/web && pnpm test -- frontmatterTitle.test
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the parser**

Create `apps/web/src/lib/frontmatterTitle.ts`:

```ts
/**
 * Pull a `title:` value out of YAML-ish frontmatter at the start of an MD
 * source slice. Strictly a UX prefill aid: gray-matter on the server is the
 * authoritative parser. Anything we can't handle returns null and the user
 * types the title themselves.
 *
 * Handles: bare values, single-quoted, double-quoted, CRLF line endings,
 * values with colons. Does not handle: multi-line values, anchors, aliases,
 * arrays, nested structures.
 */
export function extractFrontmatterTitle(input: string): string | null {
  // Normalize CRLF to LF for the scan; doesn't mutate the caller's source.
  const src = input.replace(/\r\n/g, '\n');

  if (!src.startsWith('---\n')) return null;

  const bodyStart = '---\n'.length;
  const closeIdx = src.indexOf('\n---', bodyStart);
  if (closeIdx === -1) return null;

  const block = src.slice(bodyStart, closeIdx);
  const lines = block.split('\n');

  for (const line of lines) {
    const m = /^title:\s*(.*)$/.exec(line);
    if (!m) continue;
    let raw = m[1].trim();
    if (raw.length === 0) return null;

    if (
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    ) {
      raw = raw.slice(1, -1);
    }

    return raw.length > 0 ? raw : null;
  }

  return null;
}
```

- [ ] **Step 4: Re-run the tests**

```
cd apps/web && pnpm test -- frontmatterTitle.test
```

Expected: PASS — all 13 cases.

- [ ] **Step 5: Commit**

```
git add apps/web/src/lib/frontmatterTitle.ts apps/web/src/lib/frontmatterTitle.test.ts
git commit -m "feat(web): client-side frontmatter title parser for prefill"
```

---

### Task 12: Wire title prefill into the upload route

**Files:**
- Modify: `apps/web/src/routes/upload.tsx`

- [ ] **Step 1: Add prefill effect to `UploadPage`**

In `apps/web/src/routes/upload.tsx`, add the import:

```ts
import { extractFrontmatterTitle } from '../lib/frontmatterTitle.ts';
```

After the `useState` declarations (between `setError` and the existing `onSubmit`), add a new effect:

```ts
  // Frontmatter title prefill: when the user picks a .md/.markdown file and
  // hasn't typed a title yet, read the first 8 KB and try to lift `title`
  // out of YAML-ish frontmatter. Silent on any failure — server is
  // authoritative if this misses.
  useEffect(() => {
    if (!file) return;
    if (title.trim().length > 0) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) return;

    let cancelled = false;
    file
      .slice(0, 8192)
      .text()
      .then((head) => {
        if (cancelled) return;
        const t = extractFrontmatterTitle(head);
        if (t && title.trim().length === 0) {
          setTitle(t);
        }
      })
      .catch(() => {
        // silent
      });

    return () => {
      cancelled = true;
    };
  }, [file, title]);
```

Add `useEffect` to the React import line:

```ts
import { useEffect, useState, type FormEvent } from 'react';
```

- [ ] **Step 2: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

```
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Manually verify**

```
pnpm dev
```

In a browser at `http://localhost:5173/upload`:

1. Pick a `.md` file with `---\ntitle: My Doc\n---\n` at the top → Title input should populate with "My Doc".
2. Type "Custom Title" in the title input, then pick the same `.md` file → title should NOT be overwritten (still "Custom Title").
3. Pick a `.html` file → title should NOT be touched.

Stop the dev server.

- [ ] **Step 5: Commit**

```
git add apps/web/src/routes/upload.tsx
git commit -m "feat(web): prefill title from .md frontmatter on upload"
```

---

### Task 13: Clipboard copy helper (TDD)

**Files:**
- Create: `apps/web/src/lib/clipboardCopy.ts`
- Create: `apps/web/src/lib/clipboardCopy.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `apps/web/src/lib/clipboardCopy.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { copyText, type CopyAdapter } from './clipboardCopy.ts';

function makeAdapter(overrides: Partial<CopyAdapter> = {}): CopyAdapter {
  return {
    writeWithApi: overrides.writeWithApi ?? (() => Promise.reject(new Error('no api'))),
    writeWithFallback: overrides.writeWithFallback ?? (() => false),
  };
}

describe('copyText', () => {
  it('returns api on the happy path', async () => {
    const writeWithApi = vi.fn().mockResolvedValue(undefined);
    const result = await copyText('hello', makeAdapter({ writeWithApi }));
    expect(result).toBe('api');
    expect(writeWithApi).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand on api rejection', async () => {
    const writeWithApi = vi.fn().mockRejectedValue(new Error('denied'));
    const writeWithFallback = vi.fn().mockReturnValue(true);
    const result = await copyText('hello', makeAdapter({ writeWithApi, writeWithFallback }));
    expect(result).toBe('fallback');
    expect(writeWithFallback).toHaveBeenCalledWith('hello');
  });

  it('returns failed when both paths fail', async () => {
    const writeWithApi = vi.fn().mockRejectedValue(new Error('denied'));
    const writeWithFallback = vi.fn().mockReturnValue(false);
    const result = await copyText('hello', makeAdapter({ writeWithApi, writeWithFallback }));
    expect(result).toBe('failed');
  });

  it('does not call fallback when api succeeds', async () => {
    const writeWithApi = vi.fn().mockResolvedValue(undefined);
    const writeWithFallback = vi.fn().mockReturnValue(true);
    await copyText('hello', makeAdapter({ writeWithApi, writeWithFallback }));
    expect(writeWithFallback).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd apps/web && pnpm test -- clipboardCopy.test
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/clipboardCopy.ts`:

```ts
export type CopyResult = 'api' | 'fallback' | 'failed';

export interface CopyAdapter {
  writeWithApi: (text: string) => Promise<void>;
  writeWithFallback: (text: string) => boolean;
}

/** DOM-based fallback for browsers/contexts where navigator.clipboard is
 *  unavailable (insecure context, very old browsers). Hidden textarea +
 *  document.execCommand('copy'). */
function defaultFallback(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

function defaultApi(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return Promise.reject(new Error('clipboard API unavailable'));
  }
  return navigator.clipboard.writeText(text);
}

const DEFAULT_ADAPTER: CopyAdapter = {
  writeWithApi: defaultApi,
  writeWithFallback: defaultFallback,
};

export async function copyText(
  text: string,
  adapter: CopyAdapter = DEFAULT_ADAPTER,
): Promise<CopyResult> {
  try {
    await adapter.writeWithApi(text);
    return 'api';
  } catch {
    return adapter.writeWithFallback(text) ? 'fallback' : 'failed';
  }
}
```

- [ ] **Step 4: Re-run the tests**

```
cd apps/web && pnpm test -- clipboardCopy.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add apps/web/src/lib/clipboardCopy.ts apps/web/src/lib/clipboardCopy.test.ts
git commit -m "feat(web): clipboardCopy helper with execCommand fallback"
```

---

### Task 14: Menu visibility helpers (TDD)

**Files:**
- Create: `apps/web/src/lib/documentActionsMenu.ts`
- Create: `apps/web/src/lib/documentActionsMenu.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `apps/web/src/lib/documentActionsMenu.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildMenuItems, type MenuItemId } from './documentActionsMenu.ts';

const ids = (items: { id: MenuItemId }[]) => items.map((i) => i.id);

describe('buildMenuItems', () => {
  it('shows Copy and Download for a non-uploader', () => {
    const items = buildMenuItems({ isUploader: false });
    expect(ids(items)).toEqual(['copy', 'download']);
  });

  it('shows Copy, Download, separator, Delete for an uploader', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(ids(items)).toEqual(['copy', 'download', 'separator', 'delete']);
  });

  it('marks the delete item as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    const del = items.find((i) => i.id === 'delete');
    expect(del?.destructive).toBe(true);
  });

  it('does not mark copy/download as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(items.find((i) => i.id === 'copy')?.destructive).toBeFalsy();
    expect(items.find((i) => i.id === 'download')?.destructive).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```
cd apps/web && pnpm test -- documentActionsMenu.test
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/documentActionsMenu.ts`:

```ts
export type MenuItemId = 'copy' | 'download' | 'separator' | 'delete';

export interface MenuItem {
  id: MenuItemId;
  label?: string;
  destructive?: boolean;
}

export interface MenuInput {
  isUploader: boolean;
}

/** Pure function: given who's viewing, return the ordered menu items. The
 *  caller maps each item to a click handler. */
export function buildMenuItems({ isUploader }: MenuInput): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'copy', label: 'Copy comments as Markdown' },
    { id: 'download', label: 'Download comments as Markdown' },
  ];
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: 'Delete document…', destructive: true });
  }
  return items;
}
```

- [ ] **Step 4: Re-run the tests**

```
cd apps/web && pnpm test -- documentActionsMenu.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git add apps/web/src/lib/documentActionsMenu.ts apps/web/src/lib/documentActionsMenu.test.ts
git commit -m "feat(web): pure helper for document actions menu items"
```

---

### Task 15: Reorganize the document header — remove Export button, expand menu

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Add imports**

In `apps/web/src/routes/document.tsx`, add:

```ts
import { copyText } from '../lib/clipboardCopy.ts';
import { buildMenuItems, type MenuItemId } from '../lib/documentActionsMenu.ts';
```

- [ ] **Step 2: Add copy-state for the inline confirmation**

Inside `DocumentPage`, near the other `useState` calls (group with `actionsMenuState`), add:

```ts
  const [copyFeedback, setCopyFeedback] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);
```

- [ ] **Step 3: Add `copyComments` handler next to `exportComments`**

Below the existing `exportComments` function, add:

```ts
  async function copyComments() {
    if (!docQuery.data) return;
    const md = formatThreadsAsMarkdown(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
      threads,
    );
    const result = await copyText(md);
    if (result === 'failed') {
      setCopyFeedback({ kind: 'error', message: 'Copy failed. Try Download instead.' });
    } else {
      setCopyFeedback({ kind: 'success', message: 'Copied' });
    }
    setTimeout(() => setCopyFeedback(null), result === 'failed' ? 3000 : 2000);
  }
```

- [ ] **Step 4: Remove the standalone Export button from the header**

In the JSX, locate the Export button (the `<button onClick={exportComments} …>` containing the download SVG and the text `Export`). Delete that entire `<button>` element from the header.

- [ ] **Step 5: Replace the three-dot menu block with the expanded version**

Locate the existing menu block:

```tsx
          {isUploader && (
            <div className="relative hidden md:block">
              …
            </div>
          )}
```

Replace the entire `{isUploader && ( … )}` block with the following. Note: the outer `isUploader` wrap is removed; `hidden md:block` is removed so the menu appears on mobile too:

```tsx
          <div className="relative">
            <button
              type="button"
              onClick={() =>
                setActionsMenuState((s) => (s === 'closed' ? 'menu' : 'closed'))
              }
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={actionsMenuState !== 'closed'}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              ⋯
            </button>
            {actionsMenuState === 'menu' && (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-1 w-56 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-800 dark:bg-neutral-900"
              >
                {buildMenuItems({ isUploader }).map((item) => {
                  if (item.id === 'separator') {
                    return (
                      <div
                        key="sep"
                        className="my-1 border-t border-neutral-200 dark:border-neutral-800"
                        aria-hidden="true"
                      />
                    );
                  }
                  const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
                    copy: () => {
                      setActionsMenuState('closed');
                      void copyComments();
                    },
                    download: () => {
                      setActionsMenuState('closed');
                      exportComments();
                    },
                    delete: () => setActionsMenuState('confirm'),
                  };
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      onClick={onClickFor[item.id]}
                      className={`block w-full px-3 py-1.5 text-left text-xs ${
                        item.destructive
                          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
            {actionsMenuState === 'confirm' && (
              <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md dark:border-neutral-800 dark:bg-neutral-900">
                <p className="text-xs text-neutral-700 dark:text-neutral-300">
                  Delete this document? You can restore it within 30 days from the home page.
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setActionsMenuState('closed')}
                    className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await deleteDoc.mutateAsync();
                      setActionsMenuState('closed');
                      navigate('/');
                    }}
                    className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
            {copyFeedback && (
              <div
                role="status"
                aria-live="polite"
                className={`absolute right-0 z-10 mt-1 rounded border px-2 py-1 text-xs shadow-md ${
                  copyFeedback.kind === 'success'
                    ? 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
                    : 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400'
                }`}
              >
                {copyFeedback.message}
              </div>
            )}
          </div>
```

- [ ] **Step 6: Typecheck**

```
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Run all tests**

```
pnpm test
```

Expected: PASS.

- [ ] **Step 8: Manually verify**

```
pnpm dev
```

Open a document as the uploader:
- The standalone Export button should be gone.
- The `⋯` menu should contain: Copy comments as Markdown, Download comments as Markdown, separator, Delete document….
- Click Copy → "Copied" appears for ~2s; paste into Slack/textarea → MD body matches the existing Download output.
- Click Download → file downloads with the existing filename.
- Click Delete → existing confirm flow runs unchanged.

Open the same document as a different user (e.g., switch the mock-user header in devtools or open in incognito if auth allows). The menu should contain only Copy and Download — no separator, no Delete.

On mobile width (devtools responsive mode, < 768 px): the menu is reachable. Open it, Copy / Download both work.

Stop the dev server.

- [ ] **Step 9: Commit**

```
git add apps/web/src/routes/document.tsx
git commit -m "feat(web): consolidate document actions into three-dot menu (copy/download/delete)"
```

---

### Task 16: README + end-to-end manual verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README to mention `.md` upload**

In `README.md`, find the architecture section (around line 30, the `apps/api` line). Update the relevant lines to mention Markdown.

Replace:

```
- `apps/api` — Hono API server (Node 24, drizzle-orm, postgres, parse5, pino).
```

with:

```
- `apps/api` — Hono API server (Node 24, drizzle-orm, postgres, parse5, pino, markdown-it).
```

If a "Supported file types" or similar section exists below, mention `.html`, `.md`, and `.markdown` together. If no such section exists, leave it.

- [ ] **Step 2: Manual full-flow verification**

```
pnpm dev
```

In a browser:

1. Upload `apps/api/src/upload/__fixtures__/sample.md` (or any GFM-flavored MD file). Confirm:
   - Title prefills as "Sample Markdown Document".
   - Submission lands on the document page.
   - The rendered artifact looks like a styled GitHub-rendered README: heading rules, table borders, monospaced code, list bullets, task checkboxes.
   - Switching Primer's theme (UserMenu) flips the artifact's background between light and dark live.

2. Add a comment to the MD artifact. Confirm anchoring + sidebar interactions work as on HTML artifacts.

3. Copy comments → paste into Slack/textarea. Confirm output matches the existing Download contents and looks like sane MD.

4. Add a `.md` version to an existing HTML document via "+ Version". Confirm the new version renders as MD; the old HTML version still renders correctly.

5. Open a document on a mobile viewport. Confirm the `⋯` menu is reachable and both Copy + Download work.

Stop the dev server.

- [ ] **Step 3: Final repo-wide checks**

```
pnpm verify
```

Expected: typecheck, test, and audit all pass.

- [ ] **Step 4: Commit README**

```
git add README.md
git commit -m "docs: mention markdown-it in the architecture line"
```

---

## Self-review checks (run before declaring done)

1. **Spec coverage:**
   - Goal: Copy + Upload Markdown — both covered (Tasks 13–15 / Tasks 1–5).
   - Default stylesheet (Tasks 2 + 3).
   - Companion theme channel (Tasks 6 + 7).
   - Theme wiring through ArtifactIframe + DocumentPage (Tasks 8 + 9).
   - FileDropZone + AddVersionModal accept `.md` (Task 10 — shared via FileDropZone).
   - Frontmatter title prefill (Tasks 11 + 12).
   - Three-dot menu reorg + mobile reach (Tasks 14 + 15).
   - Error handling (Task 5 covers parse_failed paths; Task 13 covers clipboard failure).
   - Testing (each TDD task includes tests; manual checks in Tasks 9, 12, 15, 16).

2. **Backward compatibility (companion):** Verified in Task 6's Step 1 by reading the existing companion's parse logic — older snapshots ignore unknown init fields and unknown port messages without panic. No mass re-injection needed.

3. **Type consistency:** `Theme = 'light' | 'dark'` defined in shared (Task 6), used identically in companion (Task 7), ArtifactIframe (Task 8), DocumentPage (Task 9). `MarkdownConversionResult` fields are stable across Task 3 (definition) and Task 5 (consumption).

4. **No placeholders:** No "TBD" / "implement later" / "add appropriate error handling" instructions; every step has either exact code or an exact command + expected output.
