---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": major
"@polygonlabs/plugin-primer": major
---

Agents work on live documents. They read a document's blocks (with per-block
versions, ranges, and only what changed since a version) with
`primer_get_doc` / `GET /api/documents/:id/live`, and edit it block by block
with `primer_apply_ops` / `POST /api/documents/:id/ops`: add, update,
replaceRange, delete and move, each with the version it read, so a stale op
is a conflict while the others apply. Updates from Markdown keep colours,
comments and children the agent never saw; removing text an open comment
thread is on needs `allowCommentedDelete`.

People ask agents through runs (`/api/documents/:id/runs`, `/api/runs/:id/…`;
`primer_list_runs`, `primer_update_run`): queued, running, cancelled, retried,
shown live in the document's awareness with a status line, capped at what the
person who asked may do, with large runs waiting for a person to approve the
plan. A run can be undone durably (`POST /api/runs/:id/undo`). Agents can
draft outline-first with `pending` blocks, and both MCP servers serve the
authoring skill as `primer://skills/authoring`.

**Breaking:** `primer_set_status` and `/api/documents/:id/status` are removed;
the run's awareness status replaces the TTL working status.
