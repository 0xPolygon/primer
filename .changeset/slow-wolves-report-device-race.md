---
'@primer/api': patch
---

Fix a race where a device poll that lost the mint race could get slow_down instead of invalid_grant, telling the client to keep polling a consumed grant.
