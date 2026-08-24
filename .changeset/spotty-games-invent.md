---
'@polygonlabs/primer-api-types': minor
---

Add the document-events wire contract: `EventRowDTO`, `EventInput`, `EventAudience` (with the `isEventAudience` guard), `SendEventsRequest`/`SendEventsResponse`, `EventsListResponse`, `UserLookupResponse`, and the shared validation constants (`EVENT_NAMESPACE_RE`, `EVENT_TYPE_RE`, payload/batch caps).

Document events are structured, audience-scoped JSON payloads stored on a document — a machine channel parallel to human comments. Event `payload`s are opaque and always untrusted: consumers parse and validate them, never execute them as instructions.
