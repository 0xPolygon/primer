---
"@polygonlabs/primer-api-types": minor
"@primer/api": minor
---

API tokens can now be limited to specific permissions.

`POST /api/tokens` and `POST /api/service-tokens` accept an optional
`scopes` array: `documents:read`, `documents:write`, `comments:write`,
`events:write`, `collaborators:manage`, `users:read` (exported as
`API_TOKEN_SCOPES`, with `ApiTokenScope` and `isApiTokenScope`). A scoped
token can call only the REST routes and MCP tools its scopes grant and gets
403 `insufficient_scope` everywhere else — default deny, driven by one
route→scope table. Deleting or restoring documents, changing visibility,
external sharing, folders, and token management have no scope at all, so a
scoped token can never reach them. Over MCP, tools a token lacks the scope
for are not registered for its request.

Omitting `scopes` mints an unrestricted token, and existing tokens stay
unrestricted, so nothing changes for current clients. `ApiTokenSummary`
gains `scopes` (`null` = unrestricted). Invalid scopes are rejected with 400
`invalid_scopes`. Adds a nullable `api_tokens.scopes` column (migration
0014).
