---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

HTML uploads are live page documents. The page renders in its sandboxed frame
as uploaded, and people edit its text in place: every element whose children
are only text gets a stable `data-pid` at publish, and clicking one opens a
small editor in Primer's own window, over the element, so no keystroke reaches
the page's scripts. Text a script draws stays read-only. Comments anchor on
page text like on any prose. `<primer-table>`, `<primer-code>`,
`<primer-mermaid>` and `<primer-math>` inside a page render read-only from the
document's blocks and edit in the same overlay.

Export, checkpoints and print splice people's text into the original page at
each element's source span; everything else stays byte for byte. When an agent
republishes a page, people's text carries over per element: text only people
changed is kept, and where both changed the agent's text wins and the person's
comes back as their suggestion; repeated labels are never carried silently.
An agent in suggest mode only suggests text, and can't make a legacy document
live.

Agents see a page's source and each pid's text and version in
`primer_get_doc` (`pages`), edit a pid's text with an `update` op on
`{ tabId, blockId, pid }`, and the authoring skill explains keeping pids on
republish. New routes: `GET /api/documents/:docId/pages/:blockId` and
`.../content`.
