---
"@primer/api": patch
---

Ship Primer as a container image for the move off Railway to the platform
team's GKE clusters (0xPolygon/dry-dock).

- `Dockerfile` builds the API and SPA into one non-root image (`SERVE_STATIC=1`,
  migrations run on start), from a digest-pinned `node:24-bookworm-slim` and the
  frozen lockfile. Multi-arch, since the clusters default to arm64.
- `release-image.yml` publishes `sha-<short>` images to Artifact Registry on
  every push to master via keyless Workload Identity Federation. Kargo promotes
  them; production promotion is manual.
