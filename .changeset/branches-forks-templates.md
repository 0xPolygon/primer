---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Private branches, forks and templates for live documents.

A branch (`POST /api/documents/:id/branch`) is a private copy owned by its
creator, made from the document's Y.Doc state so block ids are kept. Comments
and open suggestions come along on copied threads. Proposing it
(`POST /api/documents/:id/propose`) compares base, parent and branch per block:
what only the branch changed becomes a suggestion on the parent, what the
parent changed alone is never proposed for reversal, and blocks both changed
are suggestions marked `conflict`. They share one change set (the branch's
id). People who own or edit the parent accept or reject the whole set
(`POST /api/change-sets/:id/accept|reject`) and decide conflicts one by one.
Proposing again replaces the set's open suggestions.

A fork (`POST /api/documents/:id/fork`, MCP `primer_fork_document`) copies the
content, files and shared records into a new document without comments,
suggestions or personal records. Owners mark a document as a template
(`PATCH` with `isTemplate`). The library has a Templates filter and "Use
template", which forks it.
