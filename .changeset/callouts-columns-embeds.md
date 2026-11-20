---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
---

Callout, multi-column and embed blocks.

- **Callouts.** A `callout` block (info, warning, success or note) switches
  kind from its icon. A Markdown GitHub alert (`> [!NOTE]`) whose body is one
  paragraph now imports as a callout and exports verbatim while untouched; an
  edited callout exports as an alert again. Richer alerts stay quotes.
- **Columns.** `columnList` and `column` layout blocks place blocks side by
  side (add a column from the list; a list left with one column dissolves).
  Markdown and plain exports read the columns in order.
- **Embeds.** An `embed` block is a link card or another Primer document,
  resolved by `GET /api/documents/:docId/embeds/:blockId` for the viewer who
  asks. A link card is fetched by the server (public addresses only, 5 s, size
  caps, cached) and handed to the browser as text and one inlined image, so
  the browser never fetches the linked page. A document embed uses the
  viewer's own permissions and shows nothing to someone who can't read it.
  Exports and static renders carry only the link.
- The slash menu gains Callout, Columns and Link card, in all six languages
  (machine-translated; flagged for native review).
