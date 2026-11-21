---
"@polygonlabs/primer-mcp": patch
---

`primer_get_version_content` with `toDisk: true` now writes the saved file readable by its owner only (POSIX mode 0600; Windows ignores mode bits), inside a private temp directory (0700 on POSIX). A failed write no longer leaves that directory behind.
