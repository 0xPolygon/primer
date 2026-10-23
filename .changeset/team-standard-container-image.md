---
"@primer/api": patch
---

Ship Primer as a versioned container image. Every release of `@primer/api` now builds a multi-architecture image tagged with the release version; the API serves the built web app from the same image and runs pending database migrations on start.
