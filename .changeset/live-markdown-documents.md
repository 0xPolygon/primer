---
"@primer/api": minor
"@primer/web": minor
---

Markdown and text documents are live: edited in place in BlockNote, with checkpoints.

- **Import keeps every byte.** A Markdown or `.txt` upload (REST or MCP)
  creates a live document. Each top-level part of the file becomes the richest
  stock BlockNote block (headings, lists, check lists, tables, code with its
  language, quotes, images). Raw HTML, footnotes, reference definitions and
  anything whose text, links, images or checkboxes wouldn't survive the
  conversion stay verbatim as source blocks with a sanitized, script-less
  preview. Front matter becomes the document's metadata.
- **Export equals the input.** An untouched document exports exactly the
  uploaded file, and editing one block changes only its lines
  (`GET /api/documents/:docId/export?format=markdown|text|html`, live or
  `&version=n`). Only source the server signed at import is re-emitted, so
  text an editor can't see never reaches an export.
- **Checkpoints.** A checkpoint is an immutable render bundle
  (`bundles/<versionId>/`: frozen Y.Doc, export, static HTML, referenced
  files, and the open threads with their quotes and comment counts).
  `POST /api/documents/:docId/checkpoints` saves one;
  `POST /api/versions/:versionId/restore` restores one as a new edit;
  `GET /api/versions/:versionId/ydoc` serves its frozen state for BlockNote's
  version history. Compare diffs checkpoint exports.
- **Files.** Image, video, audio and file blocks upload to
  `POST /api/documents/:docId/files` and store `primer-blob://<id>`, served by
  `GET /api/files/:fileId` after the document's read check, never inline
  unless passive media.
- **Editor.** BlockNote with the Ariakit UI (slash menu, toolbars, side menu,
  table handles, file panel), live cursors, version history, and an indicator
  for "Reconnecting…", "Unsaved changes" and "Changes not saved" (Retry).
- **Legacy documents.** Existing documents stay version-only HTML. Adding a
  Markdown version makes one live; its open threads are re-anchored by quote,
  and those whose quote is gone stay listed without an anchor. Publishing a
  new version onto a live document is refused with `republish_unsupported`
  until republish merges arrive. The old Markdown-to-HTML version renderer is
  removed.
