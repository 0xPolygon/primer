---
"@primer/api": patch
---

Live sync bounds its sockets: WebSocket messages over 16 MiB close the
connection (code 1009), awareness states over 4 KiB are dropped, and a peer can
publish or clear presence only under the client ids it introduced itself, so it
can't overwrite another peer's.
