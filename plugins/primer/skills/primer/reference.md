# `primer` skill reference

Progressive-disclosure detail for the `primer` skill. Read this when you need exact tool I/O, the `.primer/document.json` schema, or the error taxonomy.

## Tool I/O

Every MCP tool returns `{ content: [{ type: 'text', text: ... }] }`. On error it also sets `isError: true` and the text is JSON `{ code, message }` (parse it; branch on `code`, never on the message string). On success the text is either JSON (most tools) or a markdown summary (`primer_get_comments`).

### `primer_login`

Start a device-authorization flow.

- **Input:** `{ clientLabel?: string }`. Omit `clientLabel` — the server uses `os.hostname()` as a default and renders it on the approval page (labeled "claimed by the requesting tool, not verified", per the phishing-hardening rules). The skill should not synthesize a hostname.
- **Output:** `{ deviceCode, userCode, verificationUri, expiresIn, interval }`.
  - `deviceCode` — opaque secret; you must keep it and pass it to every `primer_login_status` call in this flow. Never show it to the user.
  - `userCode` — short human-typable code (e.g. `WDJB-MZHT`). Show to the user.
  - `verificationUri` — bare URL the user opens in a browser. Show to the user.
  - `expiresIn` — seconds until the device row expires (typically 600).
  - `interval` — recommended poll interval in seconds (the tool already honors this internally; informational).
- The tool deliberately **omits `verificationUriComplete`** (the RFC's pre-filled-code URL). Do not try to construct it. The user must type the `userCode` on the page — that's the anti-phishing posture.

### `primer_login_status`

Long-poll for completion of an in-flight login.

- **Input:** `{ deviceCode: string }` — the `deviceCode` from `primer_login`.
- **Output:** `{ status: "approved" | "pending" | "denied" | "expired" }`. On `approved`, also `{ tokenPrefix, expiresAt }` (display-only — the token itself is written to the local store and never returned).
- Long-polls server-side up to ~90 seconds per call. `pending` means the long-poll timed out before the user approved; call again with the same `deviceCode`.

### `primer_logout`

Revoke the stored token server-side (`DELETE /api/tokens/:tokenId`) and clear the local store entry.

- **Input:** `{}`.
- **Output:** `{ ok: true }`. Idempotent — succeeds even if the token is already revoked or missing.

### `primer_whoami`

- **Input:** `{}`.
- **Output:** `{ id, email, displayName }`. Errors with `code: 'not_authenticated'` if no valid token — the trigger for the login flow.

### `primer_create_document`

Create a new document and upload its first version. Multipart upload built server-side; you only pass strings.

- **Input:** `{ title: string, description?: string, content: string, format: "html" | "markdown" }`.
- **Output:** `{ documentId, versionId, url }`.

### `primer_add_version`

Upload a new version of an existing document.

- **Input:** `{ documentId: string, content: string, format: "html" | "markdown", versionNote?: string }`.
- **Output:** `{ versionId, versionNumber, url }`.

### `primer_get_document`

- **Input:** `{ documentId: string }`.
- **Output:** `{ document: { id, title, description, uploaderId, uploaderDisplayName, createdAt }, latestVersion: { id, versionNumber, versionNote, sizeBytes, createdAt } }`.

### `primer_list_versions`

- **Input:** `{ documentId: string }`.
- **Output:** `{ versions: VersionSummaryDTO[] }`, newest first.

### `primer_get_comments`

Fetch threads on a version (or the latest version of a document) and format them as markdown.

- **Input:** exactly one of `{ versionId: string }` or `{ documentId: string }`. The tool errors with `code: 'bad_request'` if you pass both or neither.
- **Output:** markdown text (not JSON):

  ```
  # Comments [on <title> (v<n>)]
  Threads: N (open: O, resolved: R)

  > <selectorText OR innerText OR "(no quote)">
  [open|resolved]
  **<author>** — <body> (<createdAt>)
  ...
  ```

  Tombstoned (deleted) comments render as a single `(deleted)` line and never spill their bodies. Empty case renders as `"No comments on this version."` with no header.

  **The quoted line is the anchored selection text — the literal text the reviewer pinned the comment to.** Use it as the locator back to your source content. The tool does not emit CSS paths; do not try to parse rendered HTML to map comments back.

## Login sequence (stateless)

`primer_login` and `primer_login_status` carry no per-server state between calls — the `deviceCode` returned by the first call flows into every subsequent `primer_login_status` call. This makes the login flow survive MCP server restarts: if the agent already has the `deviceCode`, it can resume polling after a reconnect without restarting the device-authorization handshake.

Server stays responsive to `slow_down` and `interval` internally; the skill just keeps calling `primer_login_status` until it gets a terminal status.

## Format selection

- File extension `.md` or `.markdown` → `format: "markdown"`.
- Anything else (`.html`, `.htm`, inline HTML, etc.) → `format: "html"`.
- When the user gives raw content with no filename, default to `"html"` if the content opens with `<` (looks like markup), `"markdown"` otherwise.

## 10 MB inline limit

`content` is sent inline (no file paths). The API rejects uploads larger than 10 MB with `code: 'bad_request'`. If the artifact is genuinely large, ask the user to trim it before retrying — there is no file-path input in v1.

## Upload mutations Primer makes

When Primer ingests HTML, it strips `<iframe>` and `<meta http-equiv="refresh">` (security hardening — the rendered view runs in the same origin as the app shell). Do not bother generating those tags; they will be removed before the version is rendered. Other HTML, including `<script>` tags inside the sandboxed iframe Primer wraps your content in, is preserved.

## `.primer/document.json`

Persisted state so iterations on the same artifact target the same document across agent turns.

- **Location:** `process.cwd()/.primer/document.json` — the directory the agent was invoked from. **Not** the repo root. If the agent is invoked from `~/work/charts/` and asked to publish `report.html`, the file is `~/work/charts/.primer/document.json`.
- **Before write:** `mkdir -p .primer`.
- **Schema:**

  ```jsonc
  {
    "documentId": "01J…",        // stable id of the Primer document
    "lastVersionId": "01J…",     // id of the most recently uploaded version
    "url": "https://primer.example.com/d/01J…",
    "savedAt": "2026-06-05T14:32:11.234Z"
  }
  ```

- **404 handling:** if a tool call against the recorded `documentId` returns `code: 'not_found'`, the document was deleted on the server. **Prompt the user before creating a replacement** — never silently overwrite the file. Confirm with the user, then call `primer_create_document` and write the new ids over the old file.

## Never echo the token

The MCP tools do not return the bearer token to the agent — only a `tokenPrefix` for display. Do not try to read `~/.config/primer/tokens.json`, do not surface anything that looks like `primer_pat_…`, do not include it in messages, logs, or chain-of-thought summaries. The token is stored at mode `0600` and the skill stays out of it entirely.

## Error taxonomy

Codes returned in the `code` field of tool error payloads:

| code | meaning | skill action |
|---|---|---|
| `not_authenticated` | No token, or API returned 401. | Run the login flow. |
| `forbidden` | API returned 403 (e.g. not the uploader of the document). | Tell the user the document isn't theirs. Stop. |
| `not_found` | API returned 404 (document/version id stale, or unknown id). | If from `.primer/document.json`, prompt before overwriting. Otherwise surface. |
| `bad_request` | API returned 400 (validation, size, format, missing required arg). | Surface the server's `message`. |
| `rate_limited` | Reserved; the device endpoints emit `slow_down` only. | Wait and retry. |
| `network` | Fetch failed before getting a response. | Retry once, then surface. |
| `login_denied` | User clicked Deny on the approval page. | Tell the user and stop. |
| `login_expired` | Device row expired before approval. | Offer to start again from `primer_login`. |

## MCP not configured

If the MCP server isn't installed in the user's Claude Code, tell them to install the Primer plugin:

```
/plugin marketplace add 0xPolygon/primer
/plugin install primer@primer
/reload-plugins
```

The plugin's `plugin.json` declares the MCP server with the prod `PRIMER_API_URL` baked in, so there is nothing else to configure. The token store keys by this URL, so a user can also have separate dev/staging entries side-by-side if they manually register additional MCP instances against other Primer deployments.
