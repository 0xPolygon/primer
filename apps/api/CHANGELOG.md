# @primer/api

## 0.1.0

### Minor Changes

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Structured document events with a consent-gated artifact write path ([#78](https://github.com/0xPolygon/primer/issues/78)).

  - New `events` table and REST surface: `POST /api/documents/:id/events` (atomic batches, required per-event `audience`, 256 KB payload cap, namespace/type validation), token-paginated `GET …/events`, and `GET …/events/stream` (SSE with per-row `id:`, `Last-Event-ID`/`since` resume, keepalive comments) — all scoped per-row by `audience` (`author` / `collaborators` / `artifact`).
  - Companion consent gate: artifact-originated `primer:submit-events` is relayed only from within the same trusted event dispatch that carried the user gesture, with one consumable activation per physical interaction (a tap or keystroke's whole event burst shares one authorization); acks return as `primer:submit-result`.
  - First-submission grant: the first submission by an artifact version on a document opens a Primer-owned prompt disclosing the event count, namespaces, and each audience with its plain-language meaning (who will see the data); grants persist per viewer, document, and artifact version, and re-prompt on republish or audience escalation.
  - Companion read relay: the parent page hydrates the list, holds an SSE subscription, and forwards `artifact`-audience rows verbatim into the iframe as coalesced `primer:events` batches, re-hydrating in full on reconnect and visibility regain so no row is ever silently skipped.
  - User lookup (`GET /api/users/lookup?email=`) resolving an email to the canonical user id.
  - MCP tools `primer_get_events` / `primer_send_events` on the remote MCP surface.

### Patch Changes

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Dev-only multi-user mock auth: `AUTH_MODE=mock` sessions can now pick which mock persona a browser acts as via `GET /auth/mock` (picker page, or `?user=` to set directly; per-browser cookie), and a second persona — `mock-user-2` / Mock Reviewer — is seeded alongside the existing mock user. Registered strictly inside the existing dev gate (never in production, never under `AUTH_MODE=okta`). Enables two browsers to hold sessions as different collaborators at once — required to exercise the live multi-party events relay locally. README gains a "Local dev: the events loop end-to-end" walkthrough.

- Updated dependencies [[`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db)]:
  - @polygonlabs/primer-api-types@0.2.0
