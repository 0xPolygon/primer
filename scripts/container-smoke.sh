#!/usr/bin/env bash
# Usage: scripts/container-smoke.sh <db-host>
#   <db-host>  host the container reaches Postgres and the GCS emulator on:
#              host.docker.internal on Docker Desktop (macOS), 172.17.0.1 on Linux.
#
# Local simulation of the release gate. It mirrors the docker-test action in
# 0xPolygon/pipelines step for step, including its 2xx-only readiness wait
# (added in pipelines#85; older revisions of the action accepted any status
# below 400): build primer:ci, run primer-ci, poll the health path, run the
# tests against the container, always dump logs and remove the container. So
# a release-gate failure reproduces locally. Like the gate, it starts
# fake-gcs-server (container primer-gcs, ephemeral port) and boots the image on
# the GCS storage backend.
#
# Postgres must already be up with a `primer` database reachable as
# primer:primer; the image migrates that database to this branch's schema on
# start, so point it only at a throwaway instance. This script never starts or
# stops Docker Compose, and it only ever removes the primer-ci and primer-gcs
# containers it created.
set -euo pipefail

DB_HOST="${1:?usage: $0 <db-host>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  echo "--- primer-ci logs ---"
  docker logs primer-ci || true
  docker stop primer-ci >/dev/null 2>&1 || true
  docker rm primer-ci >/dev/null 2>&1 || true
  docker rm -f primer-gcs >/dev/null 2>&1 || true
}

docker build -f "$ROOT/apps/api/Dockerfile" -t primer:ci "$ROOT"

# Remove a leftover primer-ci from an aborted run (only this name, never others).
docker rm -f primer-ci >/dev/null 2>&1 || true
# Armed only now, so a failed build doesn't print logs for a container that
# never existed.
trap cleanup EXIT

GCS_PORT="$("$ROOT/.github/scripts/start-gcs-emulator.sh" primer-ci)"

# Values are placeholders; Okta discovery is lazy and the suite never contacts it.
export DATABASE_URL="postgres://primer:primer@${DB_HOST}:5432/primer"
export AUTH_MODE=okta
export OKTA_ISSUER=https://okta.invalid
export OKTA_CLIENT_ID=ci
export OKTA_CLIENT_SECRET=ci
export AUTH_BASE_URL=http://localhost:3000
export STORAGE_BACKEND=gcs
export GCS_BUCKET=primer-ci
export STORAGE_EMULATOR_HOST="http://${DB_HOST}:${GCS_PORT}"
export LOG_LEVEL=info
export PORT=3000

docker run -d --name primer-ci -p 3000:3000 \
  -e PORT \
  -e DATABASE_URL \
  -e AUTH_MODE \
  -e OKTA_ISSUER \
  -e OKTA_CLIENT_ID \
  -e OKTA_CLIENT_SECRET \
  -e AUTH_BASE_URL \
  -e STORAGE_BACKEND \
  -e GCS_BUCKET \
  -e STORAGE_EMULATOR_HOST \
  -e LOG_LEVEL \
  primer:ci

# As in the action: only a 2xx counts as ready, and redirects are not followed,
# so a health path that bounces to login can never pass the wait.
ready=0
status=000
for i in $(seq 1 30); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/api/health" || true)
  if [[ "$status" == 2?? ]]; then
    echo "Service ready after ${i}s"
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Service did not become ready within 30s (last status ${status})" >&2
  exit 1
fi

cd "$ROOT"
# The suite reaches Postgres and the emulator from the host, not the container.
SMOKE_DATABASE_URL="postgres://primer:primer@localhost:5432/primer" \
  SMOKE_STORAGE_EMULATOR_HOST="http://localhost:${GCS_PORT}" \
  TEST_BASE_URL=http://localhost:3000 pnpm --filter api test
