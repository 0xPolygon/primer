---
name: primer
description: >-
  Publish and iterate on LLM-generated HTML or Markdown artifacts in Primer.
  Use when the user wants to share an artifact at a stable URL, push a new
  version as they iterate, or pull reviewer comments/feedback on a version.
  Auth is handled at connector-install time via OAuth in the browser; the
  skill just drives the tool surface.
---

Workflow brain over the Primer MCP tools. Use the five steps below in order; deeper detail (full tool I/O, error taxonomy, file schemas) lives in `reference.md` — read it on demand.

If the user reports the MCP tools aren't available, tell them to install/reconnect the Primer connector in their Claude client (Settings → Connectors → Primer), then re-run the request. Auth is one-time browser OAuth at install; there is no login flow inside the agent.

## 1. Auth preflight

Call `primer_whoami` first. If it succeeds, skip to step 2.

If it errors, parse the JSON payload in the tool result's text and branch on `code` (never on message text):

- `not_authenticated` → tell the user to reconnect the Primer connector (Settings → Connectors → Primer → Reconnect / Reauthorize), then stop. Do not attempt to drive an in-agent login flow — OAuth is handled by the Claude client, not by the skill.
- anything else → surface the message and stop (see "Error handling" at the end).

## 2. Create vs. iterate

Two branches, in order:

**A. User gave you a Primer URL to iterate on** (paste of a `/d/<id>` or `/d/<id>/v/<n>` URL, or an explicit ask to update an existing doc):
- Call `primer_resolve_url` with the URL. On `bad_request` "not a Primer URL", tell the user and stop.
- Use the returned `documentId` with `primer_add_version`.

**B. Otherwise, check for `.primer/document.json` in `process.cwd()`** (only meaningful when the environment has filesystem access — Claude Code, Codex; skip in Claude Web/Desktop where there is no `cwd`):
- **No file / no filesystem** → call `primer_create_document`.
  - Pick `format` from the source: `.md` or `.markdown` extension → `"markdown"`; everything else → `"html"`.
  - On success in a filesystem-capable environment, `mkdir -p .primer` in `process.cwd()`, then write `.primer/document.json` with the shape from `reference.md`.
- **File present** → call `primer_add_version` with the recorded `documentId`. After success, update `lastVersionId`, `url`, and `savedAt` in the file.

## 3. Share

Surface the `url` from the response immediately. One line, no decoration:

```
Published: <url>
```

## 4. Iterate

When the user revises the artifact, regenerate the content and call `primer_add_version` with a concise `versionNote` describing what changed (e.g. `"fixed Y-axis scale"`, `"addressed reviewer Q on assumptions"`). If you have `.primer/document.json`, update it with the new version id.

## 5. Gather feedback

Call `primer_get_comments` with `{ documentId }` to target the latest version automatically (or `{ versionId }` if pinning to a specific revision). Provide exactly one of the two.

The tool returns a markdown summary. For each open thread, use the quoted selection text (the `> ...` line) as the locator — that's the literal text the reviewer anchored to in the document, and it maps directly back to your source. Propose or apply fixes for each open thread, then push a new version via `primer_add_version` with a `versionNote` that references the addressed feedback.

## Publishing large or interactive pages

`primer_create_document`/`primer_add_version` take the whole document inline, and
Primer renders it in a **sandboxed iframe** (`allow-scripts`, no
`allow-same-origin`). Inline `<script>` runs, but this shapes how big/interactive
pages must be built:

- **Keep the payload small enough to send in one call.** A multi-hundred-KB page
  of static markup is unreliable to transmit. For data-heavy pages (long tables,
  catalogs), publish a **data-driven** doc: embed the data once as JSON and render
  the DOM client-side with a small script, instead of emitting every row as markup.
- **Chunk large embedded JSON.** Split it across several
  `<script type="application/json" class="cat">…</script>` blocks (~15 KB each)
  and reassemble at runtime (`[...document.querySelectorAll('script.cat')].map(s=>s.textContent).join('')` → `JSON.parse`). Escape `<` as `<` inside the JSON so it can't break out of the script tag.
- **Clipboard:** the async `navigator.clipboard` API is **blocked** in the sandbox.
  Any copy control must fall back to a hidden-`textarea` + `document.execCommand('copy')`.
- **Copy affordance = a plain text button, not an icon.** SVG sprite `<use>` icons
  lose their `fill`/`stroke` in the sandbox and render as black blobs.
- **Full HTML documents are fine** (Primer serves them in the iframe), but the
  viewer's iframe can be slow to first-paint on heavy pages — verify by loading
  the version's `/api/versions/<id>/content` URL directly, which renders immediately.

## Error handling

Every tool error result is JSON-encoded as `{ code, message }` in the result text. Branch on `code`:

| code | action |
|---|---|
| `not_authenticated` | Tell the user to reconnect the Primer connector (Settings → Connectors → Primer). Stop — do not drive login in-agent. |
| `forbidden` | Tell the user this document isn't theirs (uploader-only ownership). Stop. |
| `not_found` | If the id came from `.primer/document.json`, the recorded document was deleted on the server. **Prompt the user before creating a new one — never silently overwrite the file.** For other 404s, surface the message. |
| `bad_request` | Surface the server's `message` verbatim — it carries validation/size/format/URL-parsing detail. |
| `rate_limited` | Wait a few seconds and retry once. If it fails again, surface and stop. |
| `network` | Retry the call once. If it fails again, surface and stop. |
| anything else | Surface `code` + `message` and stop. |

For deeper detail on tool I/O, the `.primer/document.json` schema, format selection, the 10 MB inline limit, and what Primer strips from uploaded HTML, see `reference.md`.
