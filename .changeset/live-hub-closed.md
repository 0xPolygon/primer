---
"@primer/api": patch
---

Closing the live hub refuses any socket still authenticating, so a late upgrade
can't connect after shutdown has started.
