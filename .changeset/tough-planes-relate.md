---
'@primer/api': minor
'@primer/web': minor
---

Structured document events with a consent-gated artifact write path (#78).

- New `events` table and REST surface: `POST /api/documents/:id/events` (atomic batches, required per-event `audience`, 256 KB payload cap, namespace/type validation), token-paginated `GET …/events`, and `GET …/events/stream` (SSE with per-row `id:`, `Last-Event-ID`/`since` resume, keepalive comments) — all scoped per-row by `audience` (`author` / `collaborators` / `artifact`).
- Companion consent gate: artifact-originated `primer:submit-events` is relayed only from within the same trusted event dispatch that carried the user gesture (activation consumed in-dispatch — one gesture, one submission); acks return as `primer:submit-result`.
- Companion read relay: the parent page hydrates the list, holds an SSE subscription, and forwards `artifact`-audience rows verbatim into the iframe as coalesced `primer:events` batches, with overlap re-fetch on reconnect and visibility regain.
- User lookup (`GET /api/users/lookup?email=`) resolving an email to the canonical user id.
- MCP tools `primer_get_events` / `primer_send_events` on the remote MCP surface.
