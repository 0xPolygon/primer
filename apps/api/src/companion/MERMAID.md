# Vendored Mermaid bundle

This directory contains a pinned, prebuilt Mermaid bundle served byte-for-byte
to artifact iframes. It is NOT installed via pnpm. Updates are explicit:
re-download, update the SHA-256 below, bump the filename (and `mermaidVersion.ts`),
commit.

## Current pin

- **Version:** 11.4.1
- **File:** `mermaid-v11.4.1.js` (~2.5 MB minified, ~700 KB gzipped)
- **Source URL:** https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js
- **SHA-256:** `a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e`
- **Vendored:** 2026-06-22

## Why this specific build

The CDN's `mermaid.min.js` is an esbuild IIFE that ends with
`globalThis.mermaid = <default-export>;`. It is self-contained — no
dynamic chunk imports at runtime. The artifact CSP enforces
`connect-src 'none'`, so the ESM build (which fetches layout-engine
chunks lazily) does not work in our environment. The companion's loader
imports for that global-assign side effect and reads `window.mermaid`
afterwards (`apps/api/src/companion/v1.js:107-134`).

## Cost and caching

The bundle is lazy-loaded — fetched only when at least one canonical
Mermaid block is present in the document AND the document doesn't ship
its own Mermaid bootstrap. Served from `/companion/mermaid-v<version>.js`
with `cache-control: public, max-age=31536000, immutable`, so a viewer
fetches it once per version per origin. First-paint cost on a slow
connection is meaningful — keep that in mind when bumping the version
or adding more vendored libraries on the same path.

## Bumping the version

1. Pick the new version (latest stable v11.x).
2. `curl` the new file to `mermaid-v<new-version>.js` in this directory.
3. Record the new SHA-256 above.
4. Update `mermaidVersion.ts` and every hard-coded reference in `v1.js`.
5. Run `pnpm --filter @primer/api test && pnpm --filter @primer/api build`.
6. Delete the previous `mermaid-v<old-version>.js` file in the same commit.
