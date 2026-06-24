# Diff Between Versions — Design

**Date:** 2026-06-24
**Status:** Approved
**Issue:** [#20](https://github.com/0xPolygon/primer/issues/20)

## Goal

Let a user compare two versions of the same document and see a GitHub-style diff of the rendered text. The diff is reachable from the existing version selector and also via a stable, shareable URL — pasting `/d/:docId/compare/3/7?view=split` into a browser lands on that exact view (subject to the standard auth gate).

Diff content is the **rendered text** of each version (HTML stripped to structural plaintext), not the stored HTML source. View modes: unified and split, both with word-level intra-line highlighting.

## Non-goals

- Diffing the stored HTML source, the original Markdown, or anything other than rendered text. Source isn't preserved separately (versions are stored as post-transform HTML), so a source diff would require a schema change. Out of scope for this iteration; revisit only on real demand.
- Diffing or rendering Mermaid SVG output. SVG markup diffs are noise; the extractor collapses each diagram to a `[diagram]` placeholder.
- Backend computation of diffs. Diffing is purely client-side.
- New backend endpoints, new database fields, or any change to the versions API surface.
- Persisting per-user view-mode preference. The URL is the only state.
- Virtualization or chunked rendering for very large documents. We ship whatever `react-diff-viewer-continued` produces; revisit only if it bogs down in practice.
- Deep-linking to a specific line or hunk inside the diff.
- Three-way or N-way comparisons.

## Architecture

### High-level flow

Fully client-side. No backend changes.

```
VersionSelector (dropdown)
    │  "Compare…" link
    ▼
/d/:docId/compare                    ← Picker page
    │  user picks fromV + toV
    ▼
/d/:docId/compare/:fromV/:toV?view=… ← Result page (also a stable, shareable entry point)
    │
    ├─ useVersionsQuery → resolve fromV / toV (version numbers) → version IDs
    ├─ GET /api/versions/:fromId/content   ┐  in parallel
    ├─ GET /api/versions/:toId/content     ┘
    ├─ extractText(html) on each
    └─ <ReactDiffViewer> with splitView=…, compareMethod="diffWords"
```

The result page does **not** depend on having gone through the picker. Direct URL entry is a first-class flow. Anything the page needs comes from URL params plus the versions query — never from location state.

### Library choice

`react-diff-viewer-continued` (maintained fork of `react-diff-viewer`). Selected over `jsdiff` + custom renderer because it ships split / unified / word-level out of the box for our exact stack. Fallback if it fails the supply-chain gate (see below): `jsdiff` plus a custom renderer.

## UI surfaces

### VersionSelector

Single addition: a `Compare…` link rendered at the top of the open dropdown (above the existing `+ Add version` button if present, below otherwise). Clicking navigates to `/d/:docId/compare`. The selector retains all current click-to-navigate behavior on rows; no compare-mode toggle inside the dropdown.

File: `apps/web/src/components/VersionSelector.tsx`.

### Picker page (`/d/:docId/compare`)

New route component: `apps/web/src/routes/compareSelect.tsx`.

- Page header echoes the document's title plus a `Back to document` link.
- Body lists every version in descending order (same data as the selector), each row as a single line: `vN · note · relative timestamp · [Latest]`. Two radio columns on the left labeled `From` and `To`; one selection per column. The same version cannot be selected as both From and To (selecting in one column clears that version in the other if it was set).
- Defaults on first render:
  - `to` = latest version
  - `from` = the version immediately prior to `to` if one exists, else `to` (which leaves the Compare button disabled until the user picks something different)
- Footer: a `Compare →` button. Disabled when `from === to` or either is unset. Click navigates to `/d/:docId/compare/{fromV}/{toV}` (no `?view` — falls back to default).
- Empty case: if the document has fewer than 2 versions, show "This document only has one version. Add another version to compare."

### Result page (`/d/:docId/compare/:fromV/:toV`)

New route component: `apps/web/src/routes/compare.tsx`.

- Header: doc title · `vF → vT` (where F and T are the resolved version numbers) · Unified/Split toggle · `Back to document` link.
- Body: `<ReactDiffViewer>` with:
  - `oldValue` = extracted text of `fromV`'s content
  - `newValue` = extracted text of `toV`'s content
  - `splitView` driven by `?view` (default `split`; `?view=unified` flips it)
  - `compareMethod={DiffMethod.WORDS}` for word-level intra-line highlighting
  - `useDarkTheme` driven by `useTheme().effective === 'dark'` (existing hook at `apps/web/src/lib/useTheme.ts`, already used by `document.tsx` and the harness page).
  - `styles` prop fed our Tailwind color tokens (background, gutter, addition, deletion, word-add, word-del) so the viewer matches the rest of the app in both light and dark.
- The Unified/Split toggle updates the URL via `setSearchParams({ view })` — no full navigation, back-button behaves intuitively.

### App routing

`apps/web/src/App.tsx` registers:

```
/d/:docId/compare                    → compareSelect.tsx
/d/:docId/compare/:fromV/:toV        → compare.tsx
```

Both routes are siblings of the existing document routes under `AppShell` in `App.tsx`. They inherit the same shell, the same auth gate, and the same nav as the rest of the authenticated app. They are not nested under `/d/:docId`'s page component — the result page fetches what it needs on its own.

## URL shape

- Picker: `/d/:docId/compare`.
- Result: `/d/:docId/compare/:fromV/:toV` with optional `?view=split|unified`.
- `:fromV` and `:toV` are **version numbers** (user-facing integers). Resolved to UUIDs at runtime via `useVersionsQuery`. Choosing version numbers over UUIDs is deliberate: readable shareable URLs, no UUID leakage in chat/email, and the versions list cache already provides O(1) resolution.
- The view-mode toggle is a query param (not a path segment) because it's an orthogonal display preference rather than part of the resource identity.

## Text extraction (`extractText`)

The diff operates on rendered text, but versions are stored as post-transform HTML. `extractText(html: string): string` produces a deterministic plaintext rendering of that HTML.

New file: `apps/web/src/lib/extractText.ts`. Pure function, no DOM dependencies beyond `DOMParser` (always present in the browser; no `jsdom` or other dep).

### Rules

1. Parse with `new DOMParser().parseFromString(html, 'text/html')`.
2. Walk the document body. Emit:
   - `textContent` of inline nodes.
   - A trailing `\n` after each block-level boundary: `p`, `h1`–`h6`, `li`, `tr`, `pre`, `blockquote`, `div`, `section`, `article`, `figure`, `hr`. `<br>` emits exactly `\n`.
   - Inline `<code>` stays inline. `<pre>`/`<pre><code>` contents are preserved verbatim (including internal newlines) and terminated with a single `\n`.
3. Skip entirely (no text emitted) for:
   - `<script>` and `<style>`.
   - `<svg>` and its descendants — these come from Mermaid post-render. Replaced with the literal token `[diagram]` followed by `\n` so the user can see a diagram changed without diffing SVG soup.
4. Normalize whitespace at the end: collapse any run of 3+ blank lines down to 2; trim leading/trailing whitespace on the final string.

### Determinism

Same HTML in → same string out. The function does not depend on layout, viewport, or `window.getComputedStyle`. Tests are fixture-driven.

## Rendering / diff config

```tsx
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useTheme } from '../lib/useTheme';

const isDark = useTheme().effective === 'dark';

<ReactDiffViewer
  oldValue={fromText}
  newValue={toText}
  splitView={view === 'split'}
  compareMethod={DiffMethod.WORDS}
  showDiffOnly={false}
  useDarkTheme={isDark}
  leftTitle={`v${fromV}`}
  rightTitle={`v${toV}`}
  styles={diffStylesFromTheme(isDark)}
/>
```

`diffStylesFromTheme` lives next to the result page (`apps/web/src/routes/compare.tsx`) and maps a small set of Tailwind palette tokens to the `styles` shape the library expects. We do not import the library's stock CSS file; all theming flows through the prop.

`showDiffOnly={false}` is intentional: we render the full document with unchanged context, matching the GitHub diff convention.

## Error handling & edge cases

- **Invalid URL params** — `fromV` or `toV` not a positive integer: render an "Invalid compare URL" empty state with a link to the picker.
- **Unknown version number** — number is well-formed but not in the versions list for this doc: render "Version not found" with a link to the picker.
- **`fromV === toV`** on direct entry — render the same empty state as "no detectable changes": *"These two versions render to identical text."* Same component, regardless of cause.
- **`fromV > toV`** — allowed. We don't enforce chronology in the URL. The page shows whichever number is in `fromV` on the left.
- **One content fetch fails** — show the standard app-wide error component with a retry. Never render a half-diff.
- **Identical extracted text from non-identical versions** — same "render to identical text" empty state. (e.g., a version note changed but the rendered content didn't.)
- **Versions list query still loading** — standard loading state, no diff fetched yet.
- **Auth** — both new routes nest under the document context's auth gate. Unauthenticated direct entry redirects to login and returns to the exact compare URL on success. No special handling required.
- **Very large doc / very long diff** — render whatever the library produces. No virtualization, no soft size cap. Revisit only if a real document triggers a problem.
- **`?view` param missing or unrecognized** — fall back to `split`.
- **Mermaid diagrams changed between versions** — both extracted texts contain `[diagram]` in the same position, so the change is invisible in the diff. Accepted limitation of "rendered text only"; diffing SVG markup or diagram source is out of scope here. If the diagram is added/removed, the `[diagram]` token appears/disappears and is diffed correctly.

## Testing surface

We test our wiring, the text extractor, and the URL/state handling. We don't test the diff library's internals.

### Unit tests

- `apps/web/src/lib/extractText.test.ts` — fixture-driven:
  - Plain paragraphs and headings produce expected line breaks.
  - Ordered and unordered lists produce one line per item.
  - A `<table>` produces one line per row.
  - Fenced `<pre><code>` preserves internal newlines verbatim.
  - `<script>` / `<style>` content is dropped entirely.
  - An inline `<svg>` is replaced with `[diagram]`.
  - Three or more blank lines collapse to two.
  - Leading/trailing whitespace trimmed.

### Component tests

- `apps/web/src/routes/compareSelect.test.tsx`:
  - Renders all versions; defaults to `from = previous`, `to = latest`.
  - Compare button disabled when `from === to` or either is unset.
  - Clicking Compare navigates to `/d/:docId/compare/{fromV}/{toV}`.
  - Document with one version shows the empty-state message and no Compare button.
- `apps/web/src/routes/compare.test.tsx`:
  - Given two mocked content responses, renders the diff viewer with both texts present.
  - `?view=unified` renders unified; toggling the control updates the URL.
  - Invalid `fromV` (non-integer) shows the "Invalid compare URL" state.
  - Unknown version number shows the "Version not found" state.
  - `fromV === toV` shows the "identical text" state.
  - One fetch failure shows the error state, not a half-diff.

### Not tested

- `react-diff-viewer-continued`'s rendering output, color choices, or word-splitting algorithm.
- Auth redirects (covered by the existing document-route gate's tests).
- Visual snapshots of the diff in light vs. dark.

## Supply-chain gate

Before `react-diff-viewer-continued` is added to `apps/web/package.json`, verify:

- The pinned version is at least 14 days old (matches `minimumReleaseAge` in `pnpm-workspace.yaml`).
- No `postinstall` / `install` / `preinstall` scripts on the package or any new transitive dep (matches `allowBuilds: {}`).
- License is MIT or Apache-2.0 (compatible with the rest of the repo).
- Transitive dep tree reviewed and summarized in the PR description (new top-level adds, license bumps).

If any check fails, stop and flag it before doing anything else. Do not swap to a different library without explicit approval. The pre-agreed fallback on a gate failure is `jsdiff` plus a custom renderer; that path becomes its own decision.

## Acceptance criteria

- From a document viewer, clicking the version selector's `Compare…` link opens `/d/:docId/compare`.
- The picker page lists all versions, defaults `to` to the latest version and `from` to the version before it, and disables the Compare button until two distinct versions are selected.
- Clicking Compare on the picker page lands on `/d/:docId/compare/{fromV}/{toV}` with a working diff.
- Pasting `/d/:docId/compare/3/7` directly into the browser (with the user authenticated) renders the same diff view, no detour through the picker.
- Appending `?view=unified` switches to unified mode; the in-page Unified/Split toggle updates the URL via `setSearchParams` so back-button works.
- Additions and deletions are line-highlighted; word-level changes are highlighted inside changed lines.
- The diff colors are legible in both light and dark mode.
- A document with one version shows the picker's single-version empty state.
- Selecting the same version on both sides (or arriving at a same-version URL) shows the "identical text" empty state, not an empty page.
- Two versions that render to identical text show the "identical text" empty state.
- An invalid or unknown version number in the URL shows a clear empty state with a link back to the picker; no crash, no half-render.
- A version containing a Mermaid `<svg>` block diffs against a version without it as a single `[diagram]` token appearing or disappearing, not as a wall of SVG markup.
- `pnpm-workspace.yaml`, sanitizer allowlists, CSP headers, and the artifact rendering pipeline are not modified by this change.
- No new backend route, no new shared API type, no migration.
