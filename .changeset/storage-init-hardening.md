---
"@primer/api": patch
---

First-boot creation of the import signing key is create-only: a starter that
loses the race loads the winner's key instead of replacing it. Google Cloud
Storage requests now time out instead of hanging.
