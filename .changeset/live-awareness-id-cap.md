---
"@primer/api": patch
---

Presence is capped at 8 client ids per live connection, so one message of many
small awareness states can't fan out to every peer.
