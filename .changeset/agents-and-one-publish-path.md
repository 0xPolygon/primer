---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Agents become their own identities, and every publish goes through one path.

- **Agents.** A person adds agents under Settings → API tokens → Agents and
  mints each one scoped tokens (`/api/agents`, session-only). An agent acts
  under its own name, and the server always shows it as
  "<name> (via <person>)" wherever it is attributed (comments, uploader,
  resolver, status, emails, `/api/me`), so an agent can never pass as a
  person. Agent and OAuth client names are stripped of control and bidi
  characters and capped at 64 characters. An agent gets the higher
  of its own role and its person's role capped at editor, so it can publish
  but never delete, change visibility or manage collaborators on its person's
  documents. A person owns what their agents create. OAuth MCP clients now
  act as one agent per client and person (`agent_oauth_…`, named after the
  client). Service tokens become agents: the admin-only service-token section
  and `/api/service-tokens` are gone. **Existing service tokens are revoked
  by the migration**: with those routes gone nobody could list or revoke
  them, so mint replacements as agent tokens. `/api/me` returns `kind` and
  `viaUserId`; `CommentDTO` gains `authorKind` and `authorVia`; api-types adds
  `AgentDTO` and the agent request/response types.
- **Agents never resolve a person's thread.** Resolving or reopening a thread
  a person wrote in is refused for agents with the fix "Reply in the thread
  and ask a person to resolve it."
- **One publish path.** REST upload, REST add-version and the MCP publish
  tools share `publishDocument`, so MCP Markdown now carries the same theme
  marker as REST. Every version keeps its uploaded bytes verbatim. `.txt`
  uploads are accepted (`format: "text"` over MCP). Adding a version takes an
  optional `baseVersionNumber` (form field, and `primer_add_version` in both
  MCP servers); a stale base is refused with 409 `stale_base` and a fix, and
  two publishes on one base can't both win. Refusals carry
  `{ code, message, fix }` (api-types `Refusal`); REST keeps its `error` code
  alongside.
- **Page outbound policy.** The artifact CSP becomes `artifactCsp(policy)`;
  `standard` is unchanged, and `records` (for record-reading pages, later)
  allows no remote origin.
