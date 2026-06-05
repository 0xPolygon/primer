# @primer/mcp

Stdio MCP server for Primer — exposes Primer documents, versions, and
comments as tools, and bundles a device-authorization login flow for both
in-agent and CLI use. Used by Claude Code (and any other MCP-compatible
client) via stdio.

## Install in Claude Code

```
claude mcp add primer --env PRIMER_API_URL=https://primer.example.com -- npx -y @primer/mcp
```

When this package is published to npm, pin a version in the command above
(e.g. `npx -y @primer/mcp@0.1.0`) so the local install doesn't drift.
During local development, point `--` at the built entrypoint instead of
`npx`:

```
claude mcp add primer --env PRIMER_API_URL=http://localhost:3000 -- node /abs/path/to/apps/mcp/dist/index.js
```

## Logging in

Primer uses the OAuth 2.0 device authorization flow. Two entry points,
sharing one token store.

### In-agent (preferred)

The Primer skill calls `primer_login`, which returns a `deviceCode`,
`userCode`, and `verificationUri`. The skill prints them to you in this
exact shape (see the [design spec, Section 5][spec]):

```
Open this URL in your browser:
  https://primer.example.com/device

Then type this code on the page:
  WXYZ-1234
```

You open the URL, **type the code from your terminal into the page**
(the page does not pre-fill it from the URL — this is an intentional
phishing mitigation, see [design spec, Section 6][spec]), and approve.
The skill then long-polls `primer_login_status` until the server
returns `approved`; the token is written to your local store, never
shown to the agent or printed in the terminal.

### CLI

If you want to log in without an agent in the loop (e.g. before a
scripted session), run the same flow from the shell:

```
node apps/mcp/dist/index.js login
# or, after install/publish:
primer-mcp login
```

The CLI prints the same `verificationUri` + `userCode` pair, polls
quietly (with a `Still waiting...` heartbeat every ~15s during long
waits), and exits `0` once you approve. On `denied` or `expired` it
exits `1` with a short message.

The CLI never auto-opens a browser and never echoes the bare token.

[spec]: ../../docs/superpowers/specs/2026-06-05-primer-api-mcp-agent-design.md

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PRIMER_API_URL` | yes | Base URL of the Primer API, e.g. `http://localhost:3000` or `https://primer.example.com`. Used both to call the API and as the token-store key. |
| `PRIMER_API_TOKEN` | no | If set, the server uses this token verbatim and skips the store entirely. Intended for CI / impersonation. Takes precedence over the store. |
| `PRIMER_TOKEN_FILE` | no | Relocate the token store away from the default path. Same JSON shape, same `0600` permission requirements. |

## Token store

`@primer/mcp` writes tokens to `~/.config/primer/tokens.json`
(override with `PRIMER_TOKEN_FILE`). The file is a plain JSON object
keyed by normalized `PRIMER_API_URL`, so one store can hold tokens for
local-dev, staging, and prod simultaneously without collision.

Each entry holds `{ tokenId, token, prefix, savedAt }`. Writes are
**atomic** — temp file with mode `0600`, `fsync`, rename — so an
in-agent `primer_login_status` and a `primer-mcp login` running side by
side can't tear a write.

Token lookup precedence on every tool call:
1. `PRIMER_API_TOKEN` env var
2. Store entry for the current `PRIMER_API_URL`
3. No token → tools return `code: 'not_authenticated'`.

`primer_logout` revokes the server-side token (`DELETE /api/tokens/:id`)
and removes the local entry. Idempotent.

## Tools

| Tool | Purpose |
|---|---|
| `primer_login` | Start a device-authorization login. Returns `deviceCode`, `userCode`, `verificationUri`, `expiresIn`, `interval`. |
| `primer_login_status` | Long-poll the device flow. Returns `{ status: 'approved' \| 'pending' \| 'denied' \| 'expired' }`. On `approved` the token is written to the store; the agent never sees it. |
| `primer_logout` | Revoke + clear the stored token for the current `PRIMER_API_URL`. |
| `primer_whoami` | Return the authenticated Primer user (`id`, `email`, `displayName`). |
| `primer_create_document` | Create a new document with an initial version. |
| `primer_add_version` | Upload a new version of an existing document. |
| `primer_get_document` | Fetch a document + its latest-version metadata. |
| `primer_list_versions` | List all versions of a document, newest first. |
| `primer_get_comments` | Fetch comment threads on a version (or the latest version of a document) as a markdown summary. |

Inline content (passed via `primer_create_document` / `primer_add_version`)
is capped at **10 MB per upload**. Larger payloads will be rejected by
the API with `code: 'bad_request'`.

## Error code taxonomy

Every tool error returns `{ code, message }` JSON in `content[0].text`
with `isError: true`. Codes are machine-checkable; skills should branch
on `code`, never on `message` text.

| Code | Meaning / fix |
|---|---|
| `not_authenticated` | No token, or the token was rejected. Run `primer_login`. |
| `forbidden` | The token is valid but the document isn't yours. |
| `not_found` | The id is stale or never existed. |
| `bad_request` | Validation failure, payload too large, wrong format, or any non-2xx the client couldn't classify. |
| `rate_limited` | Server returned 429. Back off and retry. |
| `network` | Transport-layer failure (DNS, connection refused, TLS). Transient — retry. |
| `login_denied` / `login_expired` | Surfaced by `primer_login_status` as a status value (not a thrown error). Start a fresh login. |

## Manual smoke (optional)

To verify the bundle locally without a real Primer instance:

```
pnpm --filter @primer/mcp build
node --check apps/mcp/dist/index.js
PRIMER_API_URL= node apps/mcp/dist/index.js   # should exit 1 with "PRIMER_API_URL is required."
```

To exercise the full device flow, point the CLI at a running API:

```
PRIMER_API_URL=http://localhost:3000 node apps/mcp/dist/index.js login
```
