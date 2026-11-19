---
"@primer/api": minor
"@polygonlabs/primer-mcp": minor
---

One way to add choices and tasks: `primer_add_choice`, `primer_add_task` and
`primer_update_task` are removed from both MCP servers in favour of
`primer_apply_ops` with `{ json }` blocks (the authoring skill and
`reference.md` show the shapes). `primer_propose_pick`,
`primer_list_decisions` and `primer_list_tasks` stay. Collaborator tools now
refuse through the shared `{code, message, fix}` shape.
