# `primer` skill reference

Progressive-disclosure detail for the `primer` skill. Read this when you need exact tool I/O, the `.primer/document.json` schema, or the error taxonomy.

## Tool I/O

Every MCP tool returns `{ content: [{ type: 'text', text: ... }] }`. On error it also sets `isError: true` and the text is JSON `{ code, message }` (parse it; branch on `code`, never on the message string). On success the text is either JSON (most tools) or a markdown summary (`primer_get_comments`).

### `primer_whoami`

- **Input:** `{}`.
- **Output:** `{ id, email, displayName }`. Errors with `code: 'not_authenticated'` if the OAuth token is missing or invalid — the trigger to tell the user to reconnect the connector.

### `primer_resolve_url`

Parse a Primer document URL into ids the other tools can use.

- **Input:** `{ url: string }`.
- **Output:** `{ documentId: string, versionNumber?: number }`. `versionNumber` is set when the URL includes `/v/<n>`; absent for a plain `/d/<id>` URL.
- Errors with `code: 'bad_request'` and message `"not a Primer URL"` if the input doesn't parse. Errors with `code: 'not_found'` if the resolved id doesn't correspond to a live document.

### `primer_create_document`

Create a new document and upload its first version.

- **Input:** `{ title: string, description?: string, content: string, format: "html" | "markdown" }`.
- **Output:** `{ documentId, versionId, url }`.

### `primer_add_version`

Upload a new version of an existing document.

- **Input:** `{ documentId: string, content: string, format: "html" | "markdown", versionNote?: string }`.
- **Output:** `{ versionId, versionNumber, url }`.

### `primer_get_document`

- **Input:** exactly one of `{ documentId: string }` or `{ url: string }`. If `url` is passed, the server resolves it via the same rules as `primer_resolve_url`.
- **Output:** `{ document: { id, title, description, uploaderId, uploaderDisplayName, createdAt }, latestVersion: { id, versionNumber, versionNote, sizeBytes, createdAt } }`. Metadata only — for the raw HTML content use `primer_get_version_content`.

### `primer_get_version_content`

Fetch the raw HTML content of a Primer version. Use when you need the actual document body — not just metadata — to summarize, iterate on, or reason about existing content.

- **Input:** any one of:
  - `{ versionId: string }` — direct lookup.
  - `{ documentId: string }` — resolves to the latest version.
  - `{ url: string }` — a Primer URL. If it carries `/v/<n>`, that specific version; otherwise the latest.
- **Output:** `{ documentId, versionId, versionNumber, sizeBytes, content }`. `content` is the HTML exactly as stored (already sanitized at upload time — safe to feed straight back into the model).
- Errors with `code: 'bad_request'` when no input is given or the URL doesn't parse; `code: 'not_found'` for unknown versionIds, soft-deleted documents, or `/v/<n>` values that don't exist on the doc.
- No ownership gate — mirrors the API's share-by-URL read model.

### `primer_list_versions`

- **Input:** `{ documentId: string }`.
- **Output:** `{ versions: VersionSummaryDTO[] }`, newest first.

### `primer_list_documents`

List documents, newest first, keyset-paginated.

- **Input:** `{ scope?: "all" | "mine", limit?: number, cursor?: string }`. `limit` is clamped to 1–100 (default 25). `cursor` is the `nextCursor` from the previous page.
- **`scope`:** `"all"` (default) lists every document (share-by-URL model); `"mine"` lists only documents the current user uploaded. **Ask the user which they want** — their own documents or everyone's — before choosing. Default is `"all"`.
- **Output:** `{ scope, documents: DocumentSummaryDTO[], nextCursor: string | null, hasMore: boolean }`. Pass `nextCursor` back as `cursor` to page; stop when `hasMore` is `false`. An unknown `cursor` errors with `code: 'bad_request'`.

### `primer_find_document`

Case-insensitive substring search over document title and description. Paginated like `primer_list_documents`.

- **Input:** `{ query: string, scope?: "all" | "mine", limit?: number, cursor?: string }`. LIKE wildcards in `query` are matched literally. Errors with `code: 'bad_request'` when `query` is empty.
- **`scope`:** same semantics as `primer_list_documents` — `"all"` (default) searches every document; `"mine"` searches only the caller's uploads. **Ask the user** before scoping.
- **Output:** `{ query, scope, documents: DocumentSummaryDTO[], nextCursor, hasMore }`.

### `primer_get_document_comments`

All comment threads across **every** version of a document (not just the latest), grouped by version.

- **Input:** `{ documentId: string }`.
- **Output:** `{ documentId, title, versions: [{ versionId, versionNumber, threadCount, markdown }], threadCount }`. Each version's `markdown` uses the same format as `primer_get_comments`. `threadCount` at the top level is the total across all versions.

### `primer_get_all_comments`

List comments across documents, newest first, keyset-paginated by comment.

- **Input:** `{ scope?: "all" | "mine", limit?: number, cursor?: string }`.
- **`scope`:** `"all"` (default) returns comments by any author on every document; `"mine"` returns only comments the current user authored. **Ask the user** whether they want their own comments or all comments before scoping.
- **Output:** `{ scope, comments: [{ id, threadId, versionId, versionNumber, documentId, documentTitle, authorId, authorDisplayName, body, mentions, createdAt, updatedAt, deletedAt, threadResolved }], nextCursor, hasMore }`. Deleted comments have an empty `body`. An unknown `cursor` errors with `code: 'bad_request'`.

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

## Auth model

Auth is OAuth 2.1 handled by the Claude client at connector-install time. The user goes through a one-time browser handshake (Okta login → consent screen → token issued to the client). Tokens rotate automatically via refresh grant; the skill never sees them. There is no in-agent login flow.

If `primer_whoami` returns `code: 'not_authenticated'`, the token was revoked (user disconnected the connector, an admin action, or refresh-token reuse detection tripped). Tell the user to reconnect the Primer connector in their Claude client's Settings; that reruns OAuth cleanly.

## Format selection

- File extension `.md` or `.markdown` → `format: "markdown"`.
- Anything else (`.html`, `.htm`, inline HTML, etc.) → `format: "html"`.
- When the user gives raw content with no filename, default to `"html"` if the content opens with `<` (looks like markup), `"markdown"` otherwise.

## 10 MB inline limit

`content` is sent inline (no file paths). The API rejects uploads larger than 10 MB with `code: 'bad_request'`. If the artifact is genuinely large, ask the user to trim it before retrying — there is no file-path input.

## Upload mutations Primer makes

When Primer ingests HTML it runs a sanitize-html **allowlist**: tags and
attributes not on the list are removed, not escaped. Highlights authors
must know:

- `<iframe>`, `<object>`, `<embed>`, `<form>`, and `<meta http-equiv>`
  are always stripped (security hardening — see the threat model in
  `apps/api/src/upload/sanitize.ts`).
- `<script>` (inline and src), inline `on*` handlers, `<style>`, and
  data-URI images/fonts **survive** — the sandboxed iframe plus
  `connect-src 'none'` bounds them.
- SVG: common shape/gradient/clip tags survive. `<use>` survives only
  with a same-document fragment `href` (`#some-id`); `xlink:href` is
  normalized to `href`; a `<use>` referencing an external document is
  removed entirely.
- Attributes not in the allowlist are dropped silently (e.g. `viewBox`
  survives on `<svg>`/`<marker>`/`<pattern>` but not on `<symbol>`).

If a construct matters to your artifact, verify survival: publish, then
`primer_get_version_content` and diff against your source. That
round-trip is cheap and catches every silent mutation.

## `.primer/document.json`

Persisted state so iterations on the same artifact target the same document across agent turns. Only meaningful in environments with filesystem access (Claude Code, Codex). Claude Web/Desktop do not use this file — instead, the user hands the agent a Primer URL, which `primer_resolve_url` (or `primer_get_document`'s URL-mode) turns back into ids.

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

## Error taxonomy

Codes returned in the `code` field of tool error payloads:

| code | meaning | skill action |
|---|---|---|
| `not_authenticated` | No token, expired, or revoked. | Tell the user to reconnect the Primer connector in their Claude client. Stop. |
| `forbidden` | API returned 403 (e.g. not the uploader of the document). | Tell the user the document isn't theirs. Stop. |
| `not_found` | API returned 404 (document/version id stale, unknown id, or URL didn't resolve). | If from `.primer/document.json`, prompt before overwriting. Otherwise surface. |
| `bad_request` | API returned 400 (validation, size, format, missing required arg, or URL didn't parse as a Primer URL). | Surface the server's `message`. |
| `rate_limited` | API returned 429. | Wait a few seconds, retry once, then surface. |
| `network` | Fetch failed before getting a response. | Retry once, then surface. |

## MCP not configured

If the Primer tools aren't available, tell the user to install/reconnect the Primer connector in their Claude client:

- **Claude Web:** Settings → Connectors → Primer → Install / Reconnect. Approves via OAuth in a browser popup.
- **Claude Desktop:** Same path — Settings → Connectors → Primer.
- **Claude Code:** `/plugin install primer@primer` (from the `0xPolygon/primer` marketplace), then `/reload-plugins`. Approves via OAuth in the system browser.

The plugin's `plugin.json` declares the MCP as an HTTP-transport server pointing at the prod `/mcp` endpoint. Users who need a different Primer deployment (dev/staging) can add it manually through their client's custom-connector UI with the appropriate `https://<host>/mcp` URL.
