---
"@primer/api": patch
---

Live page frames, the print view and every other route that serves page HTML
carry the CSP `sandbox` directive (the viewer iframe's flags, no same-origin or
popups), so opening one of those URLs on its own no longer runs the page's
scripts on Primer's origin.
