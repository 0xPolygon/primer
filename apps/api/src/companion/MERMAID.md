# Vendored Mermaid bundle

This directory contains a pinned, prebuilt Mermaid bundle served byte-for-byte
to artifact iframes. It is NOT installed via pnpm. Updates are explicit:
re-download, update the SHA-256 below, bump the filename (and `mermaidVersion.ts`),
commit.

## Current pin

- **Version:** 12.3.0
- **File:** `mermaid-v12.3.0.js` (~5.5 MB minified, ~1.6 MB gzipped)
- **Source URL:** https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js
- **SHA-256:** `336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3`
- **Vendored:** 2026-11-05

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

1. Pick the new version (latest stable). Since v12.0.0 the IIFE bundles ELK
   and uses it as the default flowchart layout; v11 bundles dagre only.
2. `curl` the new file to `mermaid-v<new-version>.js` in this directory.
3. Record the new SHA-256 above.
4. Update `mermaidVersion.ts` and every hard-coded reference in `v1.js`.
5. Run `pnpm --filter @primer/api test && pnpm --filter @primer/api build`.
6. Delete the previous `mermaid-v<old-version>.js` file in the same commit.
