---
'@primer/api': patch
---

Dev-only multi-user mock auth: `AUTH_MODE=mock` sessions can now pick which mock persona a browser acts as via `GET /auth/mock` (picker page, or `?user=` to set directly; per-browser cookie), and a second persona — `mock-user-2` / Mock Reviewer — is seeded alongside the existing mock user. Registered strictly inside the existing dev gate (never in production, never under `AUTH_MODE=okta`). Enables two browsers to hold sessions as different collaborators at once — required to exercise the live multi-party events relay locally. README gains a "Local dev: the events loop end-to-end" walkthrough.
