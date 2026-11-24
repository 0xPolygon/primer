---
"@primer/api": patch
"@primer/web": patch
---

Uploaded pages now stay sandboxed when opened on their own. The artifact
content response carries a CSP `sandbox` directive matching the viewer's
iframe, so opening a page full screen or from a pasted link no longer runs its
scripts on Primer's origin. A page can also no longer ask Primer to open one of
Primer's own URLs.
