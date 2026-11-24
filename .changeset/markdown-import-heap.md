---
"@primer/api": patch
---

Markdown import no longer exhausts the heap on large files. The conversion
check opened a new JSDOM window for every top-level block group and never
closed it; it now uses the one shared document, so a 2,000-block file imports
in well under a second.
