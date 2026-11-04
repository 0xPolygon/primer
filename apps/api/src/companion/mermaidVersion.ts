// Single source of truth for the vendored Mermaid bundle's version. Consumed
// by `mermaidAsset.ts` (route) and mirrored as a string literal in `v1.js`
// (the companion is plain JS in an IIFE; it cannot import TS modules).
//
// When bumping: update this constant, the literal in v1.js, the filename in
// `companion/`, and `MERMAID.md`. All in the same commit.

export const MERMAID_VERSION = '12.3.0';
