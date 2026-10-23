#!/usr/bin/env bash
# Usage: .github/scripts/start-gcs-emulator.sh <bucket> [host-port]
#
# Starts fake-gcs-server as the container `primer-gcs` and creates <bucket> in
# it, so the release gate boots the image on the production storage backend
# (STORAGE_BACKEND=gcs) instead of the filesystem one. The image reaches it
# through STORAGE_EMULATOR_HOST. Prints the published host port on stdout.
#
# host-port defaults to an ephemeral port; the CI trigger pins 4443 because its
# job env has to name the emulator's address before the container exists.
set -euo pipefail

BUCKET="${1:?usage: $0 <bucket> [host-port]}"
HOST_PORT="${2:-}"

docker rm -f primer-gcs >/dev/null 2>&1 || true
# In-memory backend: every gate run starts from an empty bucket.
docker run -d --name primer-gcs -p "${HOST_PORT:+$HOST_PORT:}4443" \
  fsouza/fake-gcs-server:1.52.2 -scheme http -backend memory >/dev/null

PORT="$(docker port primer-gcs 4443/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/storage/v1/b"; then
    curl -sf -o /dev/null -X POST "http://127.0.0.1:${PORT}/storage/v1/b?project=primer-ci" \
      -H 'content-type: application/json' -d "{\"name\":\"${BUCKET}\"}"
    echo "$PORT"
    exit 0
  fi
  sleep 1
done
echo "fake-gcs-server did not come up within 30s" >&2
docker logs primer-gcs >&2 || true
exit 1
