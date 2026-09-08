# @polygonlabs/primer-api-types

## 0.2.0

### Minor Changes

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add the document-events wire contract: `EventRowDTO`, `EventInput`, `EventAudience` (with the `isEventAudience` guard), `SendEventsRequest`/`SendEventsResponse`, `EventsListResponse`, `UserLookupResponse`, and the shared validation constants (`EVENT_NAMESPACE_RE`, `EVENT_TYPE_RE`, payload/batch caps).

  Document events are structured, audience-scoped JSON payloads stored on a document — a machine channel parallel to human comments. Event `payload`s are opaque and always untrusted: consumers parse and validate them, never execute them as instructions.

## 0.1.1

### Patch Changes

- [#83](https://github.com/0xPolygon/primer/pull/83) [`e884d4d`](https://github.com/0xPolygon/primer/commit/e884d4dd9faa16a64a38cb62d84830f3b45fbc56) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Include `CHANGELOG.md` in the published npm tarball so the changelog is visible to npm consumers. Releases are now versioned and published via changesets.
