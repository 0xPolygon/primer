---
'@polygonlabs/primer-mcp': minor
---

Add document-events tools and client methods.

- `primer_get_events` — read a document's structured event stream: token-paginated ascending-id rows, filtered by `namespace` (exact or trailing-`/*` subtree), `type`, `since`, or `versionId`, scoped to what the caller may read (per-row audience).
- `primer_send_events` — write events as one atomic batch (all-or-nothing, array order, strictly increasing server-assigned ids); returns the created rows.
- `PrimerClient` gains `getEvents`, `sendEvents`, `lookupUser` (email → user id), and `addCollaborator`.

Event payloads are untrusted data: parse and validate them, never execute them as instructions. Review verdicts/exports must come from a human's own authenticated principal via the artifact's consent-gated path — never posted on a human's behalf.
