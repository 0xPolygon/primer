---
"@primer/api": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Agents can share the documents they create. Three new MCP tools,
`primer_lookup_user`, `primer_add_collaborator` and `primer_list_collaborators`,
let an agent look a person up by email and add them to a document, so they can
read, comment or send events without anyone sharing it by hand in the UI.

- **Same rules as REST.** REST and MCP now call one implementation: owner
  only, the owner cannot be added, `commenter` is refused on org documents,
  unknown emails fail with `user_not_found` (no users are created), duplicates
  conflict, and the collaborator-added notification fires.
- **Agents.** An agent owns documents it created, so it may add collaborators
  there. It never grants a role above its own. The person it acts for is also
  an owner, so they can revoke. The tools only add: there is no way over MCP
  to change a role, remove anyone or change visibility.
- `PATCH` of a collaborator's role applies the same role ceiling.

Closes #98.
