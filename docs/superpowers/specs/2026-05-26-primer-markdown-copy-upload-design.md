# Primer Copy & Upload Markdown — Design

**Date:** 2026-05-26
**Status:** Approved

## Goal

Two related capabilities, bundled because they share the same "Markdown as a first-class transport" framing:

1. **Copy comments to Markdown** — let any viewer copy a version's comment threads to the clipboard in the same Markdown format we already produce for download. Eliminates the download-and-reopen step when handing a thread back to Slack, Claude, or Notion.
2. **Upload Markdown** — accept `.md` / `.markdown` files in the upload and add-version flows. Convert server-side to HTML, wrap in a built-in stylesheet, then run through the existing HTML upload pipeline. The artifact is HTML from that point on; nothing downstream needs to change.

Both keep Primer's existing single-source-of-truth: artifacts are HTML, comments are JSON. Markdown is purely an I/O format.

## Non-goals

- **Copying the artifact body** as Markdown. We're only copying comments. HTML→MD round-tripping is a separate feature.
- **Preserving the original `.md` source.** Upload is a one-way conversion. The artifact is stored as HTML.
- **Per-document Markdown rendering options.** No per-artifact theme override (the stylesheet follows the Primer app theme); no custom CSS slot in frontmatter; no math/diagram extensions.
- **Syntax highlighting in code blocks.** Plain `<pre>` with a subtle background. No Shiki/highlight.js dep, no extra grammars.
- **CommonMark-strict mode.** GFM is the default and the only mode.
- **Client-side Markdown conversion.** The browser never converts. Raw `.md` bytes go to the server; server is authoritative.
- **Editing a Markdown artifact after upload.** Versions are immutable in Primer; that doesn't change here.

## Architecture

### Upload pipeline

```
POST /api/upload
        │
        ▼
  validateUpload
   (extension: .html | .md | .markdown)
   (content-type: text/html | text/markdown | text/x-markdown | empty)
        │
        ▼
   is .md or .markdown?
        │
   ┌────┴────┐
   no       yes
   │         │
   │   markdownToHtml(bytes)
   │     ├─ gray-matter strip frontmatter
   │     ├─ markdown-it (GFM, html: false)
   │     └─ wrap in <html data-theme="light"><head><style>{stylesheet}</style></head>
   │                  <body><article class="primer-md">…</article></body></html>
   │         │
   └────┬────┘
        ▼
  transformHtml      ← unchanged: parse5 + strip <iframe>/<meta refresh> + inject companion
        ▼
  storage.put + DB write
        ▼
  { documentId, versionId, url } (unchanged shape)
```

The MD branch is an additive step. After conversion, the artifact is HTML and indistinguishable from any other HTML upload for the rest of its lifecycle (storage, retrieval, render, comments, anchoring, versioning, deletion).

### Copy comments

Pure client-side change. `formatThreadsAsMarkdown` in `apps/web/src/lib/exportComments.ts` already produces the canonical Markdown form. Copy uses the same output as Download, written to the clipboard via `navigator.clipboard.writeText`. No new API surface.

## Markdown conversion

### Library

- **`markdown-it`** with `linkify: true`, `breaks: false`, `typographer: false`, `html: false`. Built-in rules cover tables, strikethrough (`~~text~~`), fenced code, and autolinks (via `linkify`).
- **`markdown-it-task-lists`** plugin for GFM task list checkboxes (`- [ ]` / `- [x]`).
- **`gray-matter`** for frontmatter parsing. Standard, robust, used everywhere.

All three deps must pass `minimumReleaseAge: 14d` (workspace policy). None require postinstall scripts beyond the existing allowlist; verify during installation.

### `html: false` is load-bearing

GFM technically allows raw inline HTML inside Markdown. Setting `html: false` means `markdown-it` emits literal text instead of executing the HTML. This is our defense against MD-source-as-script smuggling. The subsequent `transformHtml` sanitize pass (strip `<iframe>`/`<meta refresh>`) is a second line, but the primary guarantee is that `markdownToHtml` only emits the safe subset of tags.

### Module interface

`apps/api/src/upload/markdown.ts`:

```ts
export interface MarkdownConversionResult {
  html: string;                // full <!doctype html>…</html> document
  frontmatterTitle: string | null;
}

export function markdownToHtml(input: string): MarkdownConversionResult;
```

- Throws on malformed input (`markdown-it` or `gray-matter` errors propagate).
- `frontmatterTitle` is non-null only if frontmatter contains a `title` key with a non-empty string value.
- Body emptiness (frontmatter-only files) is detected by the caller: post-conversion, the inner `<article>` is whitespace-only → reject with `parse_failed`.

### Frontmatter handling

- Stripped from rendered output unconditionally.
- `title` extracted server-side and returned in `MarkdownConversionResult.frontmatterTitle`, but **the API doesn't override the user's submitted title** — title in the multipart form is still authoritative. The frontmatter title is only used client-side as a UI prefill (see Upload form).
- Other frontmatter keys are ignored. No special handling for `description`, `tags`, etc.

## Default Markdown stylesheet

A small inline `<style>` block (~3–5 KB), embedded in `<head>` at conversion time. Goals: readable, polished, theme-aware, zero external resources.

### Theming

CSS variables drive everything. The companion script (see next section) sets `document.documentElement.dataset.theme = "light" | "dark"`. Stylesheet rules key off `[data-theme]` selectors.

```css
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
```

Light is the default if no `data-theme` is set (so an MD artifact rendered without the companion still looks correct).

Palette values approximate Primer's existing dark/light tokens so the artifact doesn't feel disconnected from the chrome.

### Typography

Single-column layout, max-width 760px, generous line-height. Covers the GFM-emitted tag set: `h1`–`h6`, `p`, `ul`/`ol`/`li`, `blockquote`, `hr`, `table`/`thead`/`tbody`/`tr`/`th`/`td`, `pre`/`code`, `a`, `img`, `strong`/`em`/`del`, `input[type="checkbox"]` (task lists).

System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`. No web fonts (avoids the `font-src` allowlist friction).

### Why inline, not served

The iframe sandbox is `allow-scripts allow-forms` only — no `allow-same-origin`, so a `<link rel="stylesheet" href="/companion/v1/md.css">` would require widening CSP `style-src` and `connect-src` for the iframe. Inline `<style>` is already permitted via `style-src 'unsafe-inline'`. Inlining is cheaper, isolated, and the file is small.

### Stylesheet as code

Lives at `apps/api/src/upload/markdownStylesheet.ts`, exported as a constant string. Unit-testable (we test that `markdownToHtml` output contains the stylesheet), reviewable in PRs, version-controlled with the rest of the conversion logic.

## Companion theme channel

The MD stylesheet picks a palette based on `<html>`'s `data-theme` attribute (`"light"` by default in the saved doc, switched to `"dark"` at runtime when appropriate). The companion script — already injected into every artifact — owns setting that attribute.

### Protocol additions

Parent → companion:

- `init` gains a new field: `{ type: 'init', anchors: [...], theme: 'light' | 'dark' }`.
- New message: `{ type: 'theme_changed', theme: 'light' | 'dark' }`.

The companion sets `document.documentElement.dataset.theme = theme` on both. No-op for artifacts whose CSS doesn't have a `[data-theme]` selector (i.e., all existing HTML uploads) — the attribute is set, nothing else reacts.

### Parent wiring

- `DocumentPage` already reads `useTheme()` for app chrome. It passes the resolved theme (`"light" | "dark"`) into `ArtifactIframe` as a new prop.
- `ArtifactIframe` includes `theme` in the init payload (alongside `anchors`).
- A new effect on `theme` prop changes posts `{ type: 'theme_changed', theme }` through the port.

### Backward compatibility

Stored artifacts contain a snapshot of the companion script from upload time. After this change, the parent will be sending `theme` on init and occasional `theme_changed` messages to **all** companions, including pre-change snapshots.

The implementation plan must verify that the existing companion's message parser ignores unknown init fields and unknown message types without throwing or sending `companion_panic`. If it does throw, we harden the parser in the same change and accept that existing artifacts won't theme-react until a new version is added (which re-injects the current companion). We do **not** plan to mass re-inject historical artifacts.

## Upload form UX

### File input

- `apps/web/src/components/FileDropZone.tsx`: `accept=".html,.md,.markdown"`.
- Drop-zone messaging: "Drag an HTML or Markdown file here, or click to choose."
- `apps/web/src/components/AddVersionModal.tsx`: same `accept` change.

### Client-side title prefill (initial upload only)

When the user picks a `.md` / `.markdown` file in `routes/upload.tsx`:

1. Read first 8 KB: `file.slice(0, 8192).text()`.
2. If the slice starts with `---\n` and contains a closing `---\n` within that window, attempt to parse the enclosed lines.
3. A minimal inline parser handles `key: value` (string values, optionally quoted) — no nested structures, no arrays. We don't ship `js-yaml` to the browser; `gray-matter` does the authoritative parse server-side.
4. If `title` resolves to a non-empty string **and** the title field is currently empty, prefill it. Do not clobber a title the user already typed.
5. Any failure (no frontmatter, malformed, parser doesn't recognize the shape, no `title`, title not a string): silent no-op.

`AddVersionModal` doesn't prefill anything from frontmatter — add-version doesn't ask for a title, only a version note, and we don't use frontmatter for notes.

### No client-side conversion

Raw `.md` bytes are POSTed to `/api/upload` exactly as `.html` is today. `FormData` doesn't care about extension. The server is the only place that converts.

## Three-dot menu reorganization

`routes/document.tsx` currently has:

- A standalone "Export" button in the header (`hidden md:inline-flex`, visible to all users).
- A three-dot `⋯` menu (`hidden md:block`, wrapped in `{isUploader && ...}`), containing a single "Delete document…" item.

### After

- Standalone Export button: **removed**.
- Three-dot menu: **visible to all signed-in users** (outer `isUploader` wrap removed). Drop the `hidden md:block` so it's reachable on mobile too.
- Menu items, in order:
  1. **Copy comments as Markdown** — always shown.
  2. **Download comments as Markdown** — always shown.
  3. *visual separator* — rendered only when item 4 is present.
  4. **Delete document…** — only if `isUploader`.

### Behavior

- **Copy:** primary path is `navigator.clipboard.writeText(formatThreadsAsMarkdown(...))`. On success, briefly show "Copied" (2s inline) in the menu area. On rejection, fall back to a hidden `<textarea>` + `document.execCommand('copy')`. If both fail, show "Copy failed. Try Download instead." for ~3s.
- **Download:** reuses the existing `exportComments` function unchanged.
- **Empty-state:** both items still work on a doc with zero comments — they produce the existing "0 open threads · 0 comments" header.

### Accessibility

Menu remains `role="menu"`, items `role="menuitem"`. `aria-label="More actions"` stays. Keyboard activation works the same as click. The "Copied" feedback is announced via `aria-live="polite"`.

## Data model & API

No changes to:

- Database schema (documents, versions, threads, comments).
- Storage layout (`v1/{versionId}.html` — still `.html` because the stored artifact is HTML).
- `UploadResponse` shape (`{ documentId, versionId, url }`).
- Version content endpoint (`/api/versions/:id/content`).

Changed:

- `UploadErrorCode` — no new codes. Existing `parse_failed`, `bad_extension`, `bad_content_type` cover the MD failure modes with message updates only.
- Shared protocol types in `packages/shared/src/protocol.ts` — `InitMessage` gains `theme`; new `ThemeChangedMessage` outbound variant. Parser updated.

## Error handling

### Server-side (MD upload)

| Failure | HTTP | Error code | Message |
|---|---|---|---|
| `markdown-it.render` throws | 400 | `parse_failed` | "Markdown conversion failed: {reason}" |
| `gray-matter` throws on malformed frontmatter | 400 | `parse_failed` | "Frontmatter could not be parsed: {reason}" |
| Empty body (only frontmatter, or whitespace) | 400 | `parse_failed` | "Document body is empty." |
| Bad extension (`.txt`, `.pdf`, ...) | 400 | `bad_extension` | "File must be .html, .md, or .markdown." |
| Disallowed content-type | 400 | `bad_content_type` | "Unexpected content-type: {ct}." |
| File over 10 MB | 400 | `too_large` | (existing message) |

### Client-side

- Clipboard rejection → silent fallback to `execCommand` → on full failure, inline message in menu area for ~3s.
- Frontmatter prefill failure → silent.
- Theme prop changes after the iframe is gone → no-op (existing sender-register guards already cover this).

### Companion compatibility

- New protocol fields/messages must be safe for pre-change companion snapshots to receive. Implementation plan verifies the parser tolerates them; if not, harden the parser before merging.

## Testing

### API (`apps/api`)

- **`upload/markdown.test.ts`** — new. Unit tests on `markdownToHtml`:
  - GFM: tables, task lists, strikethrough, autolinks, fenced code blocks convert correctly.
  - Frontmatter stripped from output; `frontmatterTitle` extracted when `title:` is a non-empty string, `null` otherwise.
  - Empty body (frontmatter-only) detected by caller via empty `<article>`.
  - `html: false` enforced: raw `<script>` in MD source appears as text, not as a script tag, in output.
  - Stylesheet present in `<head>` of output.
- **`upload/validate.test.ts`** — extend: `.md` / `.markdown` accepted, mismatched content-types behavior, content-type allowlist additions.
- **`routes/upload.test.ts`** — extend: end-to-end POST of a `.md` body returns 200, stores an HTML artifact, DB row written, version-content route returns the converted HTML.
- **`upload/htmlPipeline.test.ts`** — unchanged.

### Web (`apps/web`)

- **Frontmatter prefill parser** — new unit tests: no frontmatter, malformed, title present, title missing, title not a string, title quoted, title with colons in the value.
- **Three-dot menu** — component test: visible to non-uploaders, delete item hidden for non-uploaders, Copy invokes `navigator.clipboard.writeText` (mocked), Download triggers a Blob download (mocked).
- **`ArtifactIframe` theme channel** — component test: `theme` included in init message; `theme_changed` dispatched on prop change.
- **`exportComments.test.ts`** — unchanged.

### Manual / end-to-end

- Upload a real LLM-output `.md` (Claude-generated report) — confirm legibility in light and dark.
- Toggle Primer's theme while viewing an MD artifact — confirm the artifact follows live.
- Copy comments → paste into Slack — confirm formatting is preserved.
- Copy on a doc with zero comments — confirm the empty-state output is sensible (header only).
- Open a doc on mobile — confirm the three-dot menu is reachable and Copy/Download work.

Visual regression for the stylesheet is out of scope for automated testing; a couple of representative MD files in `apps/api/src/upload/__fixtures__/` rendered manually during dev.

## Open questions

None. All design choices are settled.

## Out of scope (follow-ups)

- HTML artifact → Markdown copy (round-trip the artifact body, not just comments).
- Preserving `.md` source alongside the converted HTML.
- Math (KaTeX) and Mermaid diagrams in Markdown.
- Syntax highlighting in code blocks.
- Per-artifact theme override via frontmatter.
- Re-injecting the updated companion into historical artifacts (only needed if backward compat verification fails and we choose that fallback).
