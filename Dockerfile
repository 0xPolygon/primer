# Production image for Primer: the API (Hono) serves the built SPA from the same
# process (SERVE_STATIC=1). Published to Artifact Registry by
# .github/workflows/release-image.yml and deployed by 0xPolygon/dry-dock.
#
# Multi-arch (amd64 + arm64): the dry-dock clusters default to arm64 nodes. The
# build stage runs on the native build platform (no QEMU) and its output is
# copied into the per-target runtime stage. That is only safe while the API's
# production dependencies are pure JS — if one ever ships a native addon
# (*.node), drop --platform=$BUILDPLATFORM below.

# node:24-bookworm-slim, pinned by digest (multi-arch index). Bump deliberately.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
# pnpm version comes from package.json "packageManager".
RUN corepack enable
COPY . .
# --frozen-lockfile keeps the supply-chain hardening intact: installs exactly the
# lockfile and never re-resolves past the minimumReleaseAge gate.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @polygonlabs/primer-api-types --filter @primer/web --filter @primer/api run build
# Self-contained API directory with production dependencies only.
RUN pnpm --filter @primer/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/src /out/api/scripts /out/api/*.test.* /out/api/vitest*.ts \
 && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    SERVE_STATIC=1 \
    STATIC_ROOT=/app/web/dist \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /out/api /app/api
COPY --from=build --chown=root:root /out/web /app/web
# Code is root-owned and read-only to the app user; nothing is written to disk at
# runtime (storage is GCS in production).
USER node
EXPOSE 3000
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
