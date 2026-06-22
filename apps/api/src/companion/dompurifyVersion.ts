// apps/api/src/companion/dompurifyVersion.ts
//
// Single source of truth for the vendored DOMPurify bundle's version.
// Consumed by `dompurifyAsset.ts` (route) and mirrored as a string literal
// in `v1.js` (the companion is plain JS in an IIFE; it cannot import TS
// modules).
//
// When bumping: update this constant, the literal in v1.js, the filename
// in `companion/`, and `DOMPURIFY.md`. All in the same commit.

export const DOMPURIFY_VERSION = '3.4.8';
