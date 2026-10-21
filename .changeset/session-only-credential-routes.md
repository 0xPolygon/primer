---
"@primer/api": patch
---

Credential-management routes now require a signed-in browser session and
refuse API-token (bearer) auth with 403 `session_required`:
`POST /api/tokens`, all of `/api/service-tokens`, `POST /api/device/approve`,
`POST /api/device/deny`, and `GET /api/admin/stats`.

Before this, any bearer — including the Claude service token — could mint a
never-expiring sibling token and read its plaintext back, or approve a device
login started by someone else and hand them a 90-day token. Agents hold
bearers whose requests can be steered by untrusted content, so neither path
may be reachable with one. Listing and revoking your own tokens stays
bearer-callable; the local MCP server's `primer_logout` relies on revoke.
