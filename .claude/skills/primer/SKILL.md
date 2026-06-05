---
name: primer
description: >-
  Publish and iterate on LLM-generated HTML or Markdown artifacts in Primer.
  Use when the user wants to share an artifact at a stable URL, push a new
  version as they iterate, or pull reviewer comments/feedback on a version.
  Requires the @primer/mcp server; the skill walks the user through a one-time
  browser approval to obtain a token.
---

Workflow brain over the `@primer/mcp` tools. Use the five steps below in order; deeper detail (full tool I/O, error taxonomy, file schemas) lives in `reference.md` — read it on demand.

If the MCP server isn't configured, tell the user:

```
claude mcp add primer --env PRIMER_API_URL=<your-primer-url> -- npx -y @primer/mcp
```

Never echo, log, or otherwise surface the token. The MCP tools intentionally do not return it to you — only a `tokenPrefix` for display.

## 1. Auth preflight

Call `primer_whoami` first. If it succeeds, skip to step 2.

If it errors, parse the JSON payload in the tool result's text and branch on `code` (never on message text):

- `not_authenticated` → run the login flow below.
- anything else → surface the message and stop (see "Error handling" at the end).

### Login flow

1. Call `primer_login` (no args; the tool auto-derives `clientLabel` server-side — do not pass `os.hostname()` yourself).
2. Capture `deviceCode` from the result. You will need it for every `primer_login_status` call in this flow.
3. Output the strict prompt below verbatim — on its own, with no surrounding prose, no markdown links, no code-fence around the whole thing, no extra suggestions:

   ```
   Open this URL in your browser:
     <verificationUri>

   Then type this code on the page:
     <userCode>
   ```

4. Call `primer_login_status` with the captured `deviceCode`. It long-polls internally for up to ~90 seconds and returns `{ status }`:
   - `approved` → token is now stored. Continue to step 2 of the workflow.
   - `pending` → the long-poll timed out before the user finished approving. Call `primer_login_status` again with the same `deviceCode`. Typical logins complete in one or two calls.
   - `denied` → tell the user the request was denied in the browser; stop.
   - `expired` → tell the user the login code expired (10-minute window) and offer to start again from `primer_login`.
   - `error` → surface the `code` and stop.

Do not print the token. Do not summarize what was stored.

## 2. Create vs. iterate

Check for `.primer/document.json` in `process.cwd()` (the directory the agent was invoked from — NOT the repo root).

- **No file** (or user is publishing fresh content): call `primer_create_document`.
  - Pick `format` from the source: `.md` or `.markdown` extension → `"markdown"`; everything else → `"html"`.
  - On success, `mkdir -p .primer` in `process.cwd()`, then write `.primer/document.json` with the shape from `reference.md`.
- **File present**: call `primer_add_version` with the recorded `documentId`. After success, update `lastVersionId`, `url`, and `savedAt` in the file.

## 3. Share

Surface the `url` from the response immediately. One line, no decoration:

```
Published: <url>
```

## 4. Iterate

When the user revises the artifact, regenerate the content and call `primer_add_version` with a concise `versionNote` describing what changed (e.g. `"fixed Y-axis scale"`, `"addressed reviewer Q on assumptions"`). Update `.primer/document.json` with the new version id.

## 5. Gather feedback

Call `primer_get_comments` with `{ documentId }` to target the latest version automatically (or `{ versionId }` if pinning to a specific revision). Provide exactly one of the two.

The tool returns a markdown summary. For each open thread, use the quoted selection text (the `> ...` line) as the locator — that's the literal text the reviewer anchored to in the document, and it maps directly back to your source. Propose or apply fixes for each open thread, then push a new version via `primer_add_version` with a `versionNote` that references the addressed feedback.

## Error handling

Every tool error result is JSON-encoded as `{ code, message }` in the result text. Branch on `code`:

| code | action |
|---|---|
| `not_authenticated` | Run the login flow (step 1). |
| `forbidden` | Tell the user this document isn't theirs (uploader-only ownership). Stop. |
| `not_found` | If the id came from `.primer/document.json`, the recorded document was deleted on the server. **Prompt the user before creating a new one — never silently overwrite the file.** For other 404s, surface the message. |
| `bad_request` | Surface the server's `message` verbatim — it carries validation/size/format detail. |
| `network` | Retry the call once. If it fails again, surface and stop. |
| `login_denied` / `login_expired` | Already handled in the login flow. |
| anything else | Surface `code` + `message` and stop. |

For deeper detail on tool I/O, the `.primer/document.json` schema, format selection, the 10 MB inline limit, and what Primer strips from uploaded HTML, see `reference.md`.
