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
route→scope table. A scope only narrows what the user's role on a document
already allows; it never grants more. Deleting or restoring documents, making
a document org-visible, external sharing, folders, and token management have
no scope at all, so a scoped token can never reach them; `documents:write`
does allow making a document the user owns private. Over MCP, tools a token
lacks the scope for are not registered for its request.

Scopes apply to personal and service tokens only: OAuth access tokens
(`primer_oat_`) are not scoped yet and keep the user's full permissions.

Omitting `scopes` mints an unrestricted token, and existing tokens stay
unrestricted, so nothing changes for current clients. `ApiTokenSummary`
gains `scopes` (`null` = unrestricted). Invalid scopes are rejected with 400
`invalid_scopes`. Adds a nullable `api_tokens.scopes` column (migration
0014).
