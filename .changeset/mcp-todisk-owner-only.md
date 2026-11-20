---
"@polygonlabs/primer-mcp": patch
---

`primer_get_version_content` with `toDisk: true` now writes the saved file readable by its owner only (0600), inside the private 0700 temp directory.
