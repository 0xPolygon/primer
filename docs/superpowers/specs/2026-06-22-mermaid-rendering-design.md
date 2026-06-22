# Mermaid Diagram Rendering — Design

**Date:** 2026-06-22
**Status:** Approved
**Issue:** [#15](https://github.com/0xPolygon/primer/issues/15)

## Goal

Auto-render Mermaid diagram code blocks inside Primer artifacts (both HTML uploads and Markdown uploads) so authors don't have to ship their own Mermaid bootstrap. Fenced ```` ```mermaid ```` blocks become inline SVG at view time.

Conservative bias: never break a document that already renders correctly today. If an artifact already loads Mermaid itself, Primer steps aside.

## Non-goals

- Pan/zoom controls, lightbox, or click-to-expand on rendered diagrams.
- Custom theme palettes — only Mermaid's stock `default` (light) and `dark`.
- Mermaid Live Editor integration.
- Re-rendering or backfilling existing stored documents. Rendering happens at view time; existing documents pick this up automatically the next time they're loaded.
- `<div class="mermaid">` support (older convention, false-positive risk on author CSS classes).
- ESM/module bundle support, ELK layout engine, or any Mermaid feature that requires dynamic chunk fetches at runtime.
- Server-side pre-render. No headless browser dependency. Rendering is purely client-side, inside the existing artifact iframe.
- New npm dependencies. The Mermaid library is vendored as a static file, not pulled through `pnpm install`.

## Architecture

### Where it lives

The existing companion script (`apps/api/src/companion/v1.js`, served at `/companion/v1.js`, injected into every uploaded artifact via `apps/api/src/upload/inject.ts`) gains a single new init step that runs after the existing anchor/comment setup.

```
companion startup
  └── after the existing anchor/comment init runs,
      scan the document for canonical mermaid blocks
      ├── if none found → done (zero added cost on non-mermaid docs)
      ├── if blocks found AND author already loaded mermaid → done (skip)
      └── otherwise → dynamic-import('/companion/mermaid-v<version>.js')
                      → init mermaid with theme derived from <html data-theme>
                      → walk each block, replace content with rendered SVG
                      → listen for data-theme attribute changes → re-render
```

### The Mermaid bundle

- Vendored: `apps/api/src/companion/mermaid-v<version>.js`. Source is the official prebuilt UMD `mermaid.min.js` from a pinned upstream release — specifically the self-contained build that does not dynamic-import its layout engines at runtime (so `connect-src 'none'` in the artifact CSP does not bite us). The exact version is picked at implementation time (newest stable that passes the smoke test in §Acceptance criteria); references to `<version>` in this spec are placeholders for that picked value.
- A short audit-trail file `apps/api/src/companion/MERMAID.md` records: pinned version, upstream download URL, SHA-256 of the file, date vendored. This is what we update when bumping the version.
- The pnpm supply-chain config (`pnpm-workspace.yaml`'s `minimumReleaseAge`, `allowBuilds`, `blockExoticSubdeps`) is untouched. The bundle is a plain JS file we curl-and-commit; it is not part of `pnpm install`.

### Serving the bundle

New file `apps/api/src/routes/mermaidAsset.ts`, structurally a copy of `apps/api/src/routes/companion.ts`:

- Route: `GET /companion/mermaid-v<version>.js`.
- Versioned URL → `cache-control: public, max-age=31536000, immutable`.
- `content-type: application/javascript; charset=utf-8`.
- Same dual-candidate path lookup the companion uses (dev: `src/companion/`; prod: `dist/companion/`).
- Registered in `apps/api/src/app.ts` alongside `registerCompanionRoute`.

`apps/api/build.mjs` is updated to copy the vendored file into `dist/companion/` next to `v1.js`.

### Version constant

The pinned version is exported from a tiny shared module the companion can import at build time, e.g. `apps/api/src/companion/mermaidVersion.ts`:

```ts
export const MERMAID_VERSION = '<x.y.z>';
```

Both the route (for path matching) and the companion (for the dynamic import URL) read from this constant. Bumping the bundle = re-vendor with new filename + update the constant + commit. Cache-busting is free because the URL changes.

### CSP

Unchanged. `script-src 'self'` in `ARTIFACT_CSP` (apps/api/src/routes/versionContent.ts) already covers same-origin script loads, including the dynamic `import()` of the Mermaid bundle. `connect-src 'none'` remains in force — Mermaid is self-contained at runtime.

## Detection rules

The scanner in the companion's new init step:

```js
document.querySelectorAll('pre > code.language-mermaid, pre.mermaid')
```

These two patterns — and only these — are recognized as Mermaid blocks:

1. `<pre><code class="language-mermaid">…</code></pre>` — what `markdown-it` emits for fenced ```` ```mermaid ```` blocks.
2. `<pre class="mermaid">…</pre>` — Mermaid's own canonical authoring pattern.

### Skip-the-entire-document conditions

Before any blocks are touched, we abort if *any* of the following hold:

- An existing `<script>` tag has a `src` attribute matching the regex `/mermaid/i`.
- An existing inline `<script>` tag's text content contains the substring `mermaid.initialize` or `mermaid.run`.
- `window.mermaid` is already defined when the companion runs.

If any of these are true, the document is presumed to be driving its own Mermaid pipeline and Primer leaves it alone — no scan, no import, no DOM mutation.

### Skip-individual-block condition

A single block is skipped if it already contains an `<svg>` child (i.e., it has been pre-rendered upstream).

### Source-of-truth for diagram text

`element.textContent` of the matched element. We do not parse HTML inside the block. Mermaid receives plain text.

### Deliberately not recognized

- `<div class="mermaid">` — `mermaid` is a plausible CSS class name in author code. Skip.
- Inline `<code class="language-mermaid">` outside a `<pre>` — rare, ambiguous, skip.
- Any block the sanitizer has already rewritten beyond recognition (it would not match the selectors anyway).

## Rendering pipeline

Per matched block:

1. Resolve the **block root** — the `<pre>` element. For the markdown-it pattern (`pre > code.language-mermaid`) that's the matched element's parent; for the canonical pattern (`pre.mermaid`) it's the matched element itself. All DOM mutation targets this `<pre>`; the inner `<code>` (if present) is replaced along with everything else inside it.
2. Read `blockRoot.textContent` → diagram source.
3. Generate a unique render id (e.g., `primer-mermaid-${counter}`).
4. `const { svg } = await mermaid.render(id, source);`
5. Replace the `<pre>`'s inner content with a single `<div class="primer-mermaid">` whose `innerHTML` is the returned SVG.
6. Set `data-mermaid-source` on that wrapper to the original source text, so theme-change re-renders don't have to re-read DOM order or worry about partial state.

### Mermaid init

```js
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: dark ? 'dark' : 'default',
  fontFamily: 'inherit',
});
```

- `startOnLoad: false` is critical. It prevents Mermaid from auto-scanning the DOM and double-rendering if there's any stray bootstrap we did not detect.
- `securityLevel: 'strict'` is defense in depth — Mermaid sanitizes diagram labels.
- `fontFamily: 'inherit'` lets the artifact's own styles take over.

### Theme switching

The companion already observes the artifact iframe's `<html data-theme>` attribute for anchor styling. We piggy-back on that signal: when `data-theme` changes, re-init Mermaid with the new theme and re-render every element matching `[data-mermaid-source]` using the stored source text. No per-diagram listeners.

### Per-block failure

`mermaid.render` rejects on syntax errors. We catch, restore the original block content, and append a small inline `<div class="primer-mermaid-error">Mermaid render failed: <message></div>` inside the block. No throw bubbles up. One bad block never blocks the others, and never breaks the surrounding page.

### Bundle load failure

If `import('/companion/mermaid-v<version>.js')` rejects (network blip, asset missing), the companion emits a single `companion_log` protocol message (level `warn`) so the failure is visible in the parent's console, and leaves the document untouched. Original code blocks remain visible.

## Testing surface

We test the wiring, not the library. Mermaid itself is the upstream's responsibility.

### Unit tests

- **Scanner detection** (`apps/api/src/companion/` or a new test file): given a DOM snippet, the scanner returns the right element list for the markdown-it pattern, the canonical pattern, both together, neither, and the `<div class="mermaid">` false-positive (must be ignored).
- **Skip-conditions:** scanner aborts when (a) `<script src>` matches `/mermaid/i`, (b) inline `<script>` contains `mermaid.initialize`, (c) inline `<script>` contains `mermaid.run`, (d) `window.mermaid` is defined.
- **Skip-individual-block:** a block containing a `<svg>` child is skipped, sibling blocks still render.
- **Asset route** (`apps/api/src/routes/mermaidAsset.test.ts`): serves the vendored bundle with the expected headers and content; returns 404 for wrong version.

### Build assertion

`apps/api/build.mjs`'s post-build sanity check (existing pattern for `dist/companion/v1.js`) is extended to assert `dist/companion/mermaid-v<version>.js` exists.

### Not tested

- Mermaid's own rendering output. We don't snapshot SVGs or assert on diagram correctness.
- Theme re-render visuals.

## Known edge cases (accepted, not designed-around)

1. **Comments anchored inside mermaid source text.** A pre-existing text-range comment whose anchor lands inside a `<pre><code class="language-mermaid">…` block will drift the moment we replace the block's contents with SVG — the original text node is gone. The existing drift indicator surfaces this. Users who want to re-anchor can do so via the element-path picker on the rendered diagram.
2. **New comments on rendered diagrams.** Text-range selection on SVG text is browser-dependent and flaky. The element-path picker is the supported way to comment on a diagram. We accept this asymmetry rather than special-casing.
3. **Mermaid bundle version skew.** No client-side state beyond the standard HTTP cache. Bumping versions = fresh URL, fresh fetch, fresh render. No migration.
4. **Very large diagrams.** Mermaid can be slow on huge graphs. No render budget or async fallback. If a diagram is genuinely too big, the per-block failure mode catches it and shows the source. Revisit only if it bites in practice.

## Acceptance criteria

- A new Markdown upload containing a ```` ```mermaid ```` fenced block displays a rendered diagram in the document viewer (light theme) and re-renders correctly in dark theme.
- A new HTML upload containing a `<pre class="mermaid">…</pre>` block displays a rendered diagram.
- A new HTML upload containing the markdown-it-shaped `<pre><code class="language-mermaid">…</code></pre>` block displays a rendered diagram.
- An HTML upload that already includes a `<script src="…mermaid…">` bootstrap is **not** modified by Primer's renderer (skip-the-document path).
- An HTML upload containing a `<div class="mermaid">…</div>` block is **not** modified — the block renders as a styled `<div>` with no diagram (no false positive on author CSS).
- A Mermaid block with invalid syntax shows the original source plus an inline error note. Sibling blocks on the same page still render. The surrounding page is otherwise unaffected.
- A document containing zero Mermaid blocks does not request `/companion/mermaid-v<version>.js`.
- `dist/companion/mermaid-v<version>.js` exists after `pnpm build` in `apps/api`.
- The artifact CSP, sanitizer allowlist, and pnpm supply-chain config files are not modified by this change.
