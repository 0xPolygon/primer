---
"@primer/api": patch
---

Shutdown waits for notification emails still being sent, and the whole drain of
pending work is bounded at 15 s (what was still running is logged), so a slow
drain no longer outlives Kubernetes' termination grace.
