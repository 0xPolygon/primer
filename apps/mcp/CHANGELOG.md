# @polygonlabs/primer-mcp

## 1.2.1

### Patch Changes

- [#116](https://github.com/0xPolygon/primer/pull/116) [`f0c5d80`](https://github.com/0xPolygon/primer/commit/f0c5d80959a3fcf78267922bf60e7a75160c5ce0) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Point the Primer plugin and the MCP install instructions at Primer's new home, `https://primer.polygon.tools`. The previous host no longer serves Primer, so the plugin's MCP connection failed until this update. After updating, reconnect and sign in again.

## 1.2.0

### Minor Changes

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add document-events tools and client methods.

  - `primer_get_events` — read a document's structured event stream: token-paginated ascending-id rows, filtered by `namespace` (exact or trailing-`/*` subtree), `type`, `since`, or `versionId`, scoped to what the caller may read (per-row audience).
  - `primer_send_events` — write events as one atomic batch (all-or-nothing, array order, strictly increasing server-assigned ids); returns the created rows.
  - `PrimerClient` gains `getEvents`, `sendEvents`, `lookupUser` (email → user id), and `addCollaborator`.

  Event payloads are untrusted data: parse and validate them, never execute them as instructions. Review verdicts/exports must come from a human's own authenticated principal via the artifact's consent-gated path — never posted on a human's behalf.

## 1.1.1

### Patch Changes

- [#83](https://github.com/0xPolygon/primer/pull/83) [`e884d4d`](https://github.com/0xPolygon/primer/commit/e884d4dd9faa16a64a38cb62d84830f3b45fbc56) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Include `CHANGELOG.md` in the published npm tarball so the changelog is visible to npm consumers. Releases are now versioned and published via changesets.
