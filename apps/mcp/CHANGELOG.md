# @polygonlabs/primer-mcp

## 1.3.1

### Patch Changes

- [#128](https://github.com/0xPolygon/primer/pull/128) [`d653b18`](https://github.com/0xPolygon/primer/commit/d653b185f5f6cd7ebca107d30a55d9b314ec2502) Thanks [@taylanpince](https://github.com/taylanpince)! - Relicenses under `MIT OR Apache-2.0`: the package now ships `LICENSE-MIT` and `LICENSE-APACHE` in place of the MIT-only `LICENSE`.

## 1.3.0

### Minor Changes

- [#125](https://github.com/0xPolygon/primer/pull/125) [`535a4cb`](https://github.com/0xPolygon/primer/commit/535a4cba7f6a458042b19dd7b3c7084703e8c09a) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - `PrimerClient.addCollaborator` accepts the `responder` role (its `role` parameter is now the shared `CollaboratorRole`), and the tool descriptions say who may write events.

## 1.2.2

### Patch Changes

- [#122](https://github.com/0xPolygon/primer/pull/122) [`3badb0c`](https://github.com/0xPolygon/primer/commit/3badb0c7bfd3f6099c71687600019e747b4e1523) Thanks [@ScreamingHawk](https://github.com/ScreamingHawk)! - Clear pnpm audit: bump @modelcontextprotocol/sdk to 1.32.1 (four high advisories), @hono/node-server to the patched 2.x line, raise the body-parser and fast-uri override floors, and refresh in-range transitive pins (proxy-addr, zod, markdown-it, undici, body-parser) out of their vulnerable versions.

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
