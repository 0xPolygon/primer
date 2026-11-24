---
"@primer/api": patch
"@primer/web": patch
---

Page record bridge: shared records only, writes need a gesture. Page code can no longer read or write the viewer's personal records (the host refuses `scope: "personal"`, and the server refuses it for the host's marked calls and leaves personal changes out of a page's change feed). A page's write is applied only while the viewer's click or keypress in the page's frame is live; otherwise it is refused with `forbidden`.
