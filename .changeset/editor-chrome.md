---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
---

Editor chrome for live documents. Inline chips: `@` mentions a person, and the
slash menu adds Date and Dropdown (all work in table cells, and read as `@name`,
the date or the chosen value in text exports and static pages). Pasted Markdown
goes through the importer (`POST /api/convert/markdown`), so a paste and an
upload give the same blocks; HTML from Google Docs, Word, Notion and the web
uses BlockNote's stock paste. "Print / PDF" opens `/d/:docId/print`, the static
rendering (a checkpoint's, or the live state) with a print stylesheet. The
static rendering now follows light and dark. The editor theme follows Primer's
tokens, and every UI string moves to `apps/web/src/i18n` (en, de, es, fr, ja,
zh, picked from the browser language, with BlockNote's own dictionary).
Versions from before a document went live, listed in History, now open in the
version viewer instead of "not found" (`VersionSummaryDTO.bundled`).
