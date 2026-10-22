---
"@primer/api": patch
---

Add `GET /api/ready`, a readiness probe that checks the database (`select 1`,
2s timeout) and returns 503 `database_unavailable` when it can't reach it.
`/api/health` stays a cheap liveness check. Both are unauthenticated.

On Railway, `/api/health` kept reporting ok after the database password was
rotated, while every real request failed. Kubernetes now routes traffic only to
pods that can reach the database.
