---
"@primer/api": patch
"@primer/web": patch
"@polygonlabs/primer-mcp": patch
---

Clear dependency advisories published since the last audit: 49 findings
(1 critical, 12 high) down to 7, with no exceptions to the 14-day release-age
gate.

- `@modelcontextprotocol/sdk` ^1.32.0 (api, mcp), `hono` ^4.13.11,
  `sanitize-html` ^2.18.0, `markdown-it` ^14.3.2, `vite` ^8.1.6, `vitest`
  ^4.1.11.
- Transitive floors: `proxy-addr` 2.0.8 (critical IP spoofing via
  IPv4-mapped IPv6), `fast-uri` 3.1.8, `undici` 7.29.1, `ip-address` 10.7.1,
  `qs` 6.16.0, `source-map-js` 1.2.2, `fast-copy` 4.1.0.

The remaining fixes are still inside the gate (markdown-it 14.3.3 on 2026-10-30,
sanitize-html 2.18.1 on 2026-10-28, @vitest/mocker 4.1.12 on 2026-10-29) or
have no fix published (braces, sprintf-js; dev-only). Each is noted with its
date in pnpm-workspace.yaml.
