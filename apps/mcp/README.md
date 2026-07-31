# @polygonlabs/primer-mcp

Stdio MCP server for Primer — exposes Primer documents, versions, and
comments as tools, and bundles a device-authorization login flow for both
in-agent and CLI use. Used by Claude Code (and any other MCP-compatible
client) via stdio.

## Install in Claude Code

**Preferred — via the Primer plugin marketplace** (also installs the `primer` skill that drives this MCP):

```
/plugin marketplace add 0xPolygon/primer
/plugin install primer@primer
/reload-plugins
```

The plugin bakes the prod `PRIMER_API_URL` into the MCP server registration, so there's nothing else to configure — open a Claude Code session and say "publish this to Primer" to trigger the device-login + create-document flow.

**Manual install** (skip the plugin, register the MCP yourself):

```
claude mcp add primer \
  --env PRIMER_API_URL=https://primer-polygon.up.railway.app \
  -- npx -y @polygonlabs/primer-mcp@1.0.0
```

Pin the version so the local install doesn't drift on each `npx` run.

**Local dev** (point at a locally-running API):

```
claude mcp add primer \
  --env PRIMER_API_URL=http://localhost:3000 \
  -- node /abs/path/to/apps/mcp/dist/index.js
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

`@polygonlabs/primer-mcp` writes tokens to `~/.config/primer/tokens.json`
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

## Programmatic use (library exports)

The MCP tools are for agents deciding what to call in the moment.
Deterministic automation — publish scripts, comment watchers, CI — should
not run through an agent's context window at all. For that, the package
exports the same typed REST client and token store the MCP server itself
is built on:

```ts
import { PrimerClient } from '@polygonlabs/primer-mcp/client';
import { resolveToken } from '@polygonlabs/primer-mcp/token-store';

const baseUrl = process.env.PRIMER_API_URL ?? 'https://primer.example.com';
const token = await resolveToken({ env: process.env, baseUrl });
if (!token) throw new Error('not logged in — run primer_login first');

const client = new PrimerClient({ baseUrl, token });
const { threads } = await client.getVersionThreads(versionId);
```

`./client` exports `PrimerClient` (documents, versions, threads, upload,
token revocation) plus `PrimerApiError` and the response
types. `./token-store` exports `resolveToken` / `loadToken` / `saveToken` /
`clearToken` / `normalizeBaseUrl`, reading the same store the login flow
writes — so scripts reuse the token the user already approved instead of
minting their own credential path.

Use the client rather than hand-rolling `fetch` against the REST API: a
shadow client copies the wire protocol (paths, multipart field names,
token-store layout, env var names) and silently rots when any of it
changes. Login stays on the MCP surface — the exports deliberately do
not include the device flow.

The response types on the `./client` surface are declared locally in
`src/apiTypes.ts` (not imported from the private `@primer/shared`
workspace package), so plain `tsc --emitDeclarationOnly` produces
self-contained declarations — no declaration bundler in the toolchain.
Drift against the server's types is a CI failure via the compile-time
assertions in `src/apiTypes.drift.test.ts`.

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
pnpm --filter @polygonlabs/primer-mcp build
node --check apps/mcp/dist/index.js
PRIMER_API_URL= node apps/mcp/dist/index.js   # should exit 1 with "PRIMER_API_URL is required."
```

To exercise the full device flow, point the CLI at a running API:

```
PRIMER_API_URL=http://localhost:3000 node apps/mcp/dist/index.js login
```

## Publishing to npm (maintainers only)

Releases are cut **manually from a maintainer's machine** with npm 2FA — no automation token, no CI publish workflow. This keeps the publish path narrowly under human + hardware-MFA control.

One-time setup:
- npm account is a member of the [`@polygonlabs` npm org](https://www.npmjs.com/org/polygonlabs) with publish rights.
- npm 2FA enabled (`npm profile enable-2fa auth-and-writes`).
- Locally signed in: `npm whoami` returns your username.

Per release:

```bash
# From repo root, on a clean master with the version bump merged
git checkout master && git pull --ff-only
pnpm install --frozen-lockfile

# Verify
pnpm --filter @polygonlabs/primer-mcp typecheck
pnpm --filter @polygonlabs/primer-mcp test
pnpm --filter @polygonlabs/primer-mcp build   # also runs as prepublishOnly

# Publish (prompts for 2FA OTP interactively)
cd apps/mcp
npm publish --access public

# Confirm
npm view @polygonlabs/primer-mcp version
```

After publishing, **bump the version pin in `plugins/primer/.claude-plugin/plugin.json`** (`mcpServers.primer.args` → `["-y", "@polygonlabs/primer-mcp@<new-version>"]`) so the marketplace plugin picks up the release on the next `/plugin marketplace update primer`.

Optionally tag the release for traceability (no automation hangs off it):

```bash
git tag mcp-v<version>
git push origin mcp-v<version>
```
