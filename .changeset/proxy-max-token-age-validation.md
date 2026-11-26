---
"@primer/api": patch
---

`PROXY_AUTH_MAX_TOKEN_AGE_SEC` is validated at startup: unset keeps the default,
anything else must be a positive whole number of seconds, or the API refuses to start.
