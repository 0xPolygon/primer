---
"@primer/web": patch
---

Fix two issues on the document page: a comment that fails to post (for
example, because someone published a newer version while you were writing
it) now shows a clear error message instead of silently disappearing — and
if the reason is that a newer version exists, you get a "Switch to latest
version" button. Separately, the version switcher now keeps itself current
while you have a document open: it refreshes automatically when the tab
regains focus and every 30 seconds while visible, so a newly published
version shows up without needing a manual page refresh. The version you're
currently viewing never changes on its own.
