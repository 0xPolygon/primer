---
"@primer/api": patch
---

Security: clear npm audit advisories affecting the API service. Bumps `hono`
to 4.12.34 (CORS ReDoS, `memo()` SSR bleed, language-middleware DoS, proxy
header leak), `sanitize-html` to 2.17.7 (URI-scheme + SVG SMIL XSS,
mutation-XSS), and `@hono/node-server` to 2.0.10 (serve-static path traversal,
memory-leak DoS). Adds `pnpm` overrides pinning patched transitive copies
pulled via `@modelcontextprotocol/sdk`: `fast-uri` 3.1.6 (SSRF + host
confusion, 4 highs), `hono` 4.12.34, `@hono/node-server@1` 1.19.15, and
`body-parser` 2.3.0.

`qs` (2 moderate: array-limit bypass, isBuffer DoS; patched in 6.16.0) is
deferred until 6.16.0 clears the repo's 14-day `minimumReleaseAge` gate
(~2026-09-12).
