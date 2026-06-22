# Vendored DOMPurify bundle

This directory contains a pinned, prebuilt DOMPurify UMD bundle served
byte-for-byte to artifact iframes. It sanitizes the SVG string returned by
`mermaid.render()` before we attach it to the live DOM. It is NOT installed
via pnpm. Updates are explicit: re-download, update the SHA-256 below, bump
the filename (and `dompurifyVersion.ts`), commit.

## Current pin

- **Version:** 3.4.8
- **File:** `dompurify-v3.4.8.js` (~27 KB minified)
- **Source URL:** https://cdn.jsdelivr.net/npm/dompurify@3.4.8/dist/purify.min.js
- **SHA-256:** `b656113abe5f9b5f2c30c8b10462b7b4e947e10a49f561058822bc48e9601b4a`
- **Vendored:** 2026-06-22

## Why we vendor

CodeQL's `js/xss-through-dom` rule treats `parseFromString` (and `innerHTML`)
as sinks unless preceded by a recognized sanitizer. DOMPurify is the
industry-standard sanitizer CodeQL knows about, so using it both fixes a
real defense-in-depth gap (Mermaid's internal sanitization plus a second
pass) and clears the CodeQL alerts in one move.

The bundle is the UMD build — it self-detects classical-script, CommonJS,
and AMD contexts, and assigns `globalThis.DOMPurify = …` in the
classical-script case. We load it the same way as the Mermaid bundle:
inject a `<script src>` tag and await its `load` event
(`apps/api/src/companion/v1.js`).

## Cost and caching

The bundle is lazy-loaded alongside the Mermaid bundle — fetched only when
at least one canonical Mermaid block is present in the document AND the
document doesn't ship its own Mermaid bootstrap. Served from
`/companion/dompurify-v<version>.js` with
`cache-control: public, max-age=31536000, immutable`.

## Bumping the version

1. Pick the new version (latest stable v3.x that passes the 14-day
   `minimumReleaseAge` gate).
2. `curl` the new file to `dompurify-v<new-version>.js` in this directory.
3. Record the new SHA-256 above.
4. Update `dompurifyVersion.ts` and every hard-coded reference in `v1.js`.
5. Run `pnpm --filter @primer/api test && pnpm --filter @primer/api build`.
6. Delete the previous `dompurify-v<old-version>.js` file in the same
   commit.
