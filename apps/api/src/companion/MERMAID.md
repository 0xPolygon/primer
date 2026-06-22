# Vendored Mermaid bundle

This directory contains a pinned, prebuilt Mermaid UMD bundle served byte-for-byte
to artifact iframes. It is NOT installed via pnpm. Updates are explicit:
re-download, update the SHA-256 below, bump the filename (and `mermaidVersion.ts`),
commit.

## Current pin

- **Version:** 11.4.1
- **File:** `mermaid-v11.4.1.js`
- **Source URL:** https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js
- **SHA-256:** `a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e`
- **Vendored:** 2026-06-22

## Why this specific build

The UMD `mermaid.min.js` is self-contained — it does not dynamic-import its
layout engines at runtime. The artifact CSP enforces `connect-src 'none'`, so
the ESM build (which fetches chunks lazily) does not work in our environment.

## Bumping the version

1. Pick the new version (latest stable v11.x).
2. `curl` the new file to `mermaid-v<new-version>.js` in this directory.
3. Record the new SHA-256 above.
4. Update `mermaidVersion.ts` and every hard-coded reference in `v1.js`.
5. Run `pnpm --filter @primer/api test && pnpm --filter @primer/api build`.
6. Delete the previous `mermaid-v<old-version>.js` file in the same commit.
