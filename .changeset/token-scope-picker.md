---
"@primer/api": minor
"@primer/web": minor
---

Pick permissions when creating an API token, and require them for the
Claude service account.

`/settings/tokens` now shows each token's permissions ("Full access" for
unrestricted tokens) and lets you limit a new personal token to specific
permissions. Service-account tokens must be limited: the form requires at
least one permission, and `POST /api/service-tokens` without `scopes` is
rejected with 400 `scopes_required`. Existing service tokens keep working
and show as Full access until replaced.
