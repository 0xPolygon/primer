---
"@primer/api": patch
---

Everything on `/mcp` reaches an agent's context, so untrusted-content fencing
now follows the transport, not the caller's identity: a person's token used by
an agent gets the same fenced records, widgets, digests, decisions and tasks as
an OAuth agent, and document bodies, version content and comment text come back
fenced for every caller.
