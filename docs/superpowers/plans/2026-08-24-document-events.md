# Document events — implementation plan (issue #78)

Re-cut of spike PR #75 (`spike/agent-messages`) per the rewritten #78 spec: an
unopinionated, access-controlled store of structured **document events** with a
consent-gated artifact write path and a companion read relay. The issue body is
the spec of record; the consumer contract it is pinned against is
`0xPolygon/fleet-command` `plans/padd-channel-split.md` § "The Companion/Primer
API contract (pinned)" (write-path items 1–5, Pins 6–14).

## Shape of the change

| Layer | Change |
|---|---|
| `packages/api-types` | `EventAudience`, `EventRowDTO`, `EventInput`, list/send request+response DTOs, namespace/type regexes, payload + batch caps, runtime guards (single wire-contract home — server, web parent, and MCP all import these). |
| `apps/api` schema | `events` table: `id` bigserial PK (ordering key — positive integer, NOT uuid), `document_id` (cascade), `version_id` (set null), `author_id`, `audience` enum text, `namespace`, `type`, `payload` jsonb, `created_at`; `(document_id, id)` index. Migration generated via `drizzle-kit generate`. |
| `apps/api` lib | `lib/events.ts`: batch validation (audience required, regexes, 256 KB per-payload byte cap, batch cap, versionId∈document), atomic insert returning rows in order, audience-scoped list query with keyset pagination + namespace/type/since/versionId filters, in-process SSE fanout. Shared by the REST routes and the API MCP tools. |
| `apps/api` routes | `routes/events.ts`: `POST /api/documents/:id/events` (batch, all-or-nothing, 201 `{ events }`), `GET …/events` (token-paginated, ascending id), `GET …/events/stream` (SSE, per-row `id:`, `Last-Event-ID`/`since` resume, keepalive comments, same filters + audience scope as the list). `routes/users.ts`: `GET /api/users/lookup?email=` → `{ id }`. |
| Companion `v1.js` | Consent gate (transient activation consumed **in-dispatch**), `primer:submit-events` → `submit_events` port relay, inbound `events` → `primer:events` CustomEvent, inbound `submit_result` → `primer:submit-result`. |
| `apps/web` | Protocol additions (parse/validate `submit_events`; outbound `events` + `submit_result`), events feed (list hydrate to exhaustion + SSE subscribe + coalesced batches + overlap re-fetch on reconnect/visibility), document.tsx wiring: POST on `submit_events`, ack into iframe, relay **artifact-audience rows only**. |
| MCP | API MCP (`apps/api/src/mcp`): `primer_get_events` + `primer_send_events`. Plugin MCP (`apps/mcp`): client `getEvents`/`sendEvents` (JSON body support) + same two tools. |
| Docs | Threat-model additions in `docs/prd-primer.md` (artifact→backend write path, `artifact` audience tier, payloads-are-untrusted); route docs carry the ordering/dedupe consumer contract honestly. |

## Access control (the load-bearing part)

- **Write**: authenticated collaborators (owner included) on the document.
  Non-collaborator org readers → 403; strangers on private docs → 404;
  external-share viewers cannot authenticate to these routes at all (their
  session plane stops at `/api/share/*`) → 401.
- **Read**: per-row `audience` — `author` (row author + doc owner),
  `collaborators` (collaborators + owner), `artifact` (same readers as
  `collaborators`; additionally relayed into the sandboxed iframe by the
  parent). List/stream return, per caller, exactly the rows their identity may
  read. The relay is the injection boundary: only `artifact` rows cross it.
- **Consent**: the companion forwards `primer:submit-events` only from within
  the same trusted event dispatch that carried the user gesture, consuming the
  activation (one gesture = one submission). Auto-fired and deferred dispatches
  are refused.

## Test plan

Every #78 acceptance criterion gets a test: batch atomicity/order/increasing
ids, per-tier read scoping, pagination-to-exhaustion, namespace subtree +
type filters (list & stream), since/Last-Event-ID, SSE id + keepalive,
versionId provenance filter + mismatch `bad_request`, malformed `since`,
payload cap + regexes (padd namespace/types accepted), user lookup,
collaborator-add-at-publish, MCP tools on both surfaces, companion consent
gate (mirror-convention tests: auto-fire refused, deferred-into-unrelated-click
refused, in-dispatch accepted, one-gesture-one-submission), web protocol
parsers, events-feed coalescing/overlap logic. Full `pnpm -r test` green.
