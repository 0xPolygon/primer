# Team-standard semver Docker release for Primer

Status: PLAN (genesis commit — no stage executed yet). Supersedes primer#108.

## Motivation / Executive Summary

Primer is leaving Railway for the platform team's GKE clusters via dry-dock
(primer#103, after INC-248). The first cut of the container story — primer#108 —
is a bespoke `release-image.yml` that builds and pushes a `sha-<short>` image to
Artifact Registry on every push to `master`, with Kargo picking the newest build.
It works, but it is a second release mechanism bolted beside the one Primer
already has: changesets already version every package, cut tags, publish
`@polygonlabs/primer-mcp` and `@polygonlabs/primer-api-types` to npm, and gate
all of that behind the human-merged "Version Packages" PR. With #108, a merge
to `master` publishes a deployable image *before* that gate, the image tag
carries no version a human can relate to a changelog, and nothing ever tests
the image before it is offered to Kargo.

This change replaces #108 with the Apps Team's standard deployment paradigm.
The Version Packages merge publishes npm packages and pushes changeset release
tags; the `@polygonlabs/primer@X.Y.Z` tag triggers the team's shared
`docker-test` composite action and `apps-docker-release.yml` workflow in
`0xPolygon/pipelines`, which build the image, boot it with a real Postgres, run a
smoke suite against the running container, and only then build and publish the
multi-arch (amd64 + arm64, each on a native runner) image tagged `X.Y.Z`. Kargo
subscribes to semver tags, so the image that reaches production is the one whose
version appears in `apps/api/CHANGELOG.md` and on the GitHub Release — the same
identity every other team service has, and the one the `verify-release` tooling
expects.

Primer does not fit the shared workflow's assumptions out of the box, and this
plan does not paper over that. The `docker-test` action derives the image name
from the release tag's unscoped package name, so `@primer/api` would publish an
image called `api`; the API package is renamed `@polygonlabs/primer` (and the
repo-root package, also named `primer`, is renamed so `pnpm --filter primer` can
no longer resolve to the root — verified locally that it currently does). The
action polls `/health-check`, which Primer lacks; a liveness route is added. It
runs `pnpm --filter primer test` with `TEST_BASE_URL` pointing at the container,
but Primer's 72-file suite imports the app in-process and truncates a local
Postgres; the suite is left intact and a container smoke suite is selected
instead when `TEST_BASE_URL` is set. The SPA ships inside the API image, so a
`@primer/web`-only changeset must still produce an image; a changesets `fixed`
group makes the two packages version together.

The Dockerfile itself keeps what #108 verified (single image: API + built SPA
with `SERVE_STATIC=1`, migrations before the server, digest-pinned
`node:24-bookworm-slim`, frozen lockfile, `pnpm deploy --prod`, non-root), moved
to `apps/api/Dockerfile` where the action looks for it, with the
cross-compilation trick dropped (the shared pipeline builds each platform
natively since pipelines#71) and build provenance (`GIT_SHA`, `BUILT_AT`) wired
through to `/health-check` so a deployed pod can be matched to its release.

## Benefits

- **One release gate, not two.** A merge to `master` never produces a deployable
  image. Only the human-merged Version Packages PR does — the same gate that
  already governs npm publishes of `primer-mcp` and `primer-api-types`, so the
  service, its MCP client and its API types can never ship out of step.
- **The deployed image is versioned.** Tag `0.2.0` ⇔ `apps/api/CHANGELOG.md`
  `## 0.2.0` ⇔ GitHub Release ⇔ Kargo freight. #108's `sha-abc1234` has no such
  trail. Rollback is "promote the previous semver".
- **The image is tested before it is published.** `docker-test` builds the exact
  Dockerfile, boots it against Postgres (migrations run for real), waits for
  `/health-check`, and runs a smoke suite over HTTP against the container:
  liveness, readiness (DB reachable), SPA served, static root wired, companion
  asset present, auth gate active under `NODE_ENV=production`, mock routes
  absent. #108 tested nothing after the build.
- **No bespoke workflow to maintain.** `release-image.yml` (136 lines of
  overwrite guards, WIF plumbing, metadata-action config) is replaced by a thin
  trigger (two jobs, no logic) calling shared, SHA-pinned workflows that the
  team already keeps patched. Primer gains native-runner multi-arch builds,
  per-platform layer cache and digest-merge manifest publishing for free.
- **Manual re-release without re-tagging.** `workflow_dispatch` with the tag
  name rebuilds a release image from the release commit — the recovery path if
  the first release runs before the WIF allowlist (polygon-infrastructure#2462)
  is applied.
- **Standards alignment, measurable.** `/health-check` liveness (team
  Monitoring standard), `pnpm install --ignore-scripts` + `pnpm deploy --prod`
  (Dockerfile standard), `docker-release-trigger.yml` with `test` →
  `release (needs: test)` (Release Management standard), explicit per-name
  secrets, explicit `permissions`.
- **Build identity in the running pod.** `GET /health-check` returns
  `{ ok, gitSha, builtAt }` from the shared pipeline's provenance build-args,
  giving release verification a version probe without a new endpoint.
- **Net code: ~−100 lines of workflow YAML vs #108, +1 Dockerfile (moved), +1
  smoke suite (~80 lines), +1 route (~5 lines), +1 local simulation script.**

## Research findings the plan is grounded in

All paths are `origin/master` of `0xPolygon/primer` (`99c994d`) unless noted.

- **Release machinery today.** `.github/workflows/release.yml` runs
  `changesets/action` on push to `master` with a GitHub App token
  (`CHANGESET_RELEASE_BOT_APP_*`), `version: pnpm run ci:version`,
  `publish: pnpm exec changeset publish`, `createGithubReleases: true`.
  `.changeset/config.json`: `baseBranch: master`, `privatePackages: {version:
  true, tag: true}`, `bumpVersionsWithWorkspaceProtocolOnly: true` (deliberate,
  rationale in `.changeset/README.md`). Existing tags prove the tag shape:
  `@primer/api@0.1.0`, `@primer/web@0.1.0`, `@polygonlabs/primer-mcp@1.2.0`,
  `@polygonlabs/plugin-primer@2.2.2`, `@polygonlabs/primer-api-types@0.2.0`.
- **Lockfile is valid at release tags.** Every intra-repo dependency is
  `workspace:^`; the Version Packages commit `2410ddb` changed only `version`
  fields. Probed: `pnpm install --frozen-lockfile --lockfile-only` against the
  manifests + lockfile of `2410ddb` exits 0 under pnpm 11.8.0. So the
  Dockerfile's `--frozen-lockfile` at the tag ref is safe (release.yml's
  `--no-frozen-lockfile` comment is inherited from polygon-core-plugins and does
  not apply here).
- **`docker-test` action** (`0xPolygon/pipelines` `origin/main`,
  `.github/actions/docker-test/action.yml`), line by line:
  1. checks out `inputs.tag || github.ref_name`; pnpm from `packageManager`,
     Node from `.nvmrc`;
  2. `SERVICE="${REF%@*}"`, `VERSION="${REF##*@}"`, `IMAGE_NAME="${SERVICE#@*/}"`
     → `@primer/api@0.2.0` gives image **`api`**; `@polygonlabs/primer@0.2.0`
     gives **`primer`**;
  3. `PKG_DIR=$(pnpm --filter "$SERVICE" exec -- node -e 'process.cwd()')`;
     skips (`should_build=false`) unless **`${PKG_DIR}/Dockerfile` exists** —
     so the Dockerfile must live in `apps/api/`, not the repo root where #108
     put it. (The ops doc `service-deployment.md` still describes a
     `"dockerfile"` package.json field; the action on `main` does not read one —
     doc drift, noted as a follow-up.)
  4. `docker buildx build -f apps/api/Dockerfile -t primer:ci --load .` —
     **build context is the repo root**, with GHA layer cache;
  5. `docker run -d --name primer-ci -p 3000:3000 -e PORT=3000 -e <each
     test_vars name> primer:ci` — values come from the trigger job's `env:`;
  6. `pnpm install --frozen-lockfile` on the runner;
  7. polls **`http://localhost:3000/health-check`** 30×1s; dumps logs and fails
     otherwise;
  8. `TEST_BASE_URL=http://localhost:3000 pnpm --filter primer test`;
  9. always: `docker logs`, stop, rm.
- **`apps-docker-release.yml` → `gcp_pipeline_release_image.yaml`** (pipelines
  `origin/main`, pipelines#71 merged): registry
  `europe-west2-docker.pkg.dev/prj-polygonlabs-shared-prod/polygonlabs-docker-prod/<image_name>`,
  tag `type=raw,value=<image_tag>`, `platforms` default
  `linux/amd64,linux/arm64` each built on a native runner (`ubuntu-latest`,
  `ubuntu-24.04-arm`) and pushed by digest, merged into one manifest; passes
  build-args `GIT_SHA` and `BUILT_AT`; WIF via `shared-prod-oidc-sa` — the same
  pool/SA #108 used by hand. Secret `build_params_gh_secret_keys` is declared
  `required: true` on `apps-docker-release.yml` but the GCP pipeline treats an
  empty value as "no build params".
- **pnpm filter semantics** (probed in the local checkout, names identical on
  master): `pnpm --filter api` and `--filter @primer/api` → `apps/api`;
  **`pnpm --filter primer` → the repo root** (root `package.json` is
  `"name": "primer"`, included without `--include-workspace-root`). Any package
  whose unscoped name is `primer` therefore collides with the root until the
  root is renamed.
- **Primer API boot requirements** (`apps/api/src/index.ts`): `AUTH_MODE` must
  be `mock` or `okta`; `mock` is refused when `NODE_ENV=production` (which the
  image sets). `okta` needs `OKTA_ISSUER`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`,
  `AUTH_BASE_URL`; `OpenIdClientAdapter` discovery is **lazy** (first use), so
  placeholder values boot fine. `DATABASE_URL` is required by `dist/db/migrate.js`
  before the server starts. Storage defaults to `FilesystemStorage('./storage')`
  relative to cwd `/app/api`, which is root-owned in the image.
- **Test suite shape** (`apps/api/vitest.config.ts`): `include:
  src/**/*.test.ts` (72 files), `setupFiles: src/testing/setup.ts` (truncates
  tables via the in-process DB client), `env.DATABASE_URL` hard-set to
  `postgres://primer:primer@localhost:5432/primer_test`, `fileParallelism:
  false`. Nothing reads `TEST_BASE_URL`. `docker-compose.yml` publishes Postgres
  on fixed `5432:5432` with default password `primer_local_dev` and
  `docker/init-db.sql` creating `primer_test`; `ci.yml` uses a `services:`
  Postgres with `primer/primer`.
- **Health/auth today**: `/api/health` → `{ok:true}` in `app.ts`; primer#110
  moves it to `apps/api/src/routes/health.ts` and adds `/api/ready` (DB
  `select 1`, 2s timeout) and `PUBLIC_PATHS` entries in
  `apps/api/src/middleware/auth.ts`. Unauthenticated `/api/*` → 401 JSON;
  non-API → 302 to `/auth/login`. `/auth/mock` exists only when
  `NODE_ENV!=='production'` **and** `AUTH_MODE=mock`.
- **SPA serving**: `SERVE_STATIC=1` + `STATIC_ROOT` (default
  `../../web/dist` relative to the compiled file); `apps/web/index.html` mounts
  on `<div id="root">`; `apps/api/scripts/build.mjs` emits `dist/index.js`,
  `dist/db/migrate.js`, `dist/jobs/purge-cli.js`, `dist/companion/v1.js`,
  `dist/companion/mermaid-v<ver>.js`.
- **Deployment side** (context only): dry-dock#1445 subscribes the `primer`
  warehouse to `…/polygonlabs-docker-prod/primer` with
  `imageSelectionStrategy: NewestBuild` and `allowTagsRegexes: ['^sha-[0-9a-f]{7,}$']`,
  namespace label `cloud.google.com/default-compute-class: general-arm64`
  (the **arm64** image is what runs), liveness `gcpHealthCheckRequestPath:
  /api/health`, readiness `/api/ready`, `replicas: 0` until cutover, env/secrets
  via ESO. The team's semver precedent (`kargo/projects/web-apps/gas-station.yaml`)
  is `imageSelectionStrategy: SemVer`, `allowTagsRegexes: ['^\d+\.\d+\.\d+$']`.
  polygon-infrastructure#2462 (open) adds `0xPolygon/primer` to
  `shared-prod-oidc-sa`'s `github_repos` allowlist plus Cloud SQL PG18, bucket,
  GSA/WI and secrets.
- **Repo facts**: visibility `internal` (no public-surface PR scrubbing
  needed); default branch `master`; no `.github/CODEOWNERS`, no `.dockerignore`,
  no Husky hooks; `ci.yml` is bespoke (not the shared `ci` composite) — all out
  of scope here. `gh secret list -R 0xPolygon/primer` shows no repo-level
  secrets, so `CHANGESET_RELEASE_BOT_APP_*` (and presumably
  `build_params_gh_secret_keys`) are org-level.
- **Empty research categories**: no monitored signals (Primer has no Grafana
  dashboards/alerts yet; logs are pino with no named error classes the plan
  touches) → no Monitoring verification stage. Primer is not in the
  apps-team-ops registry (`registry find primer` → no matches) → no
  dependency-graph consumers to notify; registering it is a follow-up.

## Prerequisites (outside this repo — not stages)

These gate the **first release**, not the PR. The PR can merge before them; the
release workflow is idempotently re-runnable via `workflow_dispatch` with the
tag name once they land.

- **P1 — WIF push allowlist.** polygon-infrastructure#2462 merged and applied
  (`0xPolygon/primer` under `shared-prod-oidc-sa.github_repos`). Without it the
  `release` job fails at "Authenticate with GCP via OIDC". Recovery: re-run via
  `workflow_dispatch` `tag: @polygonlabs/primer@X.Y.Z`.
- **P2 — dry-dock#1445 switches to semver.** `kargo/projects/web-apps/primer.yaml`
  warehouse: `imageSelectionStrategy: SemVer`, `allowTagsRegexes:
  ['^\d+\.\d+\.\d+$']` (as `gas-station.yaml`); stage file `image.tag` initial
  value = the first published semver tag. Optional but recommended:
  `gcpHealthCheckRequestPath: /health-check` (liveness per team standard;
  `/api/health` keeps working either way). Owner: Taylan (his PR) — the team
  lead relays; this plan never comments on another person's PR.
- **P3 — `build_params_gh_secret_keys` reachable from `0xPolygon/primer`.** It
  is an org-level secret on other consumers (`gas-station` passes
  `${{ secrets.build_params_gh_secret_keys }}` exactly as the template does).
  Confirm the org secret's repository access includes `primer` (internal repo).
  If the reusable workflow rejects the call because the secret resolves empty,
  a repo admin adds a repo secret with value `{}`.
- **P4 — Sequencing with #109/#110.** The plan assumes primer#110 (readiness)
  and #109 (GCS storage) merge **before** this PR, so `routes/health.ts` exists
  and `/api/ready` is a smoke assertion. Fallback if the lead decides otherwise
  is written into Stage S1A and S2.
- **P5 — Follow-ups (non-blocking):** register Primer in
  `apps-team-ops/src/registry.json` and add a `verify-release` profile
  (`apps-team-ops/docs/runbooks/primer/verify-release.md`); fix the
  `service-deployment.md` drift (`"dockerfile"` field vs Dockerfile-existence
  gate); primer#111's runbook refers to "the first image tag" — semver after this.

## Open decisions (user's call; recommendation first)

1. **API package name → `@polygonlabs/primer` (recommended)** so the derived
   image is `primer`, matching dry-dock#1445's repoURL and the team convention
   (`@polygonlabs/example-rest-api` → `example-rest-api`). Alternatives:
   `@primer/primer` (same image name, keeps the `@primer` scope beside
   `@primer/web`, reads oddly); or add an `image_name` override input to the
   pipelines `docker-test` action (a cross-team shared-workflow PR, and it
   breaks the tag ⇔ image identity every other service has). Cost of the
   rename: every pending `.changeset/*.md` naming `@primer/api` must be
   rewritten in the same commit (`changeset status` fails on an unknown
   package) — including #109/#110's changesets once they land (hence P4).
2. **Root package `primer` → `primer-workspace` (recommended, required by 1).**
   Otherwise `pnpm --filter primer test` (what the action runs) resolves to the
   root *and* the API. The root is private and unpublished; only
   `.claude-plugin/marketplace.json` and the plugin manifest also use the word
   `primer`, and neither is a pnpm name.
3. **changesets `fixed` group `[["@polygonlabs/primer", "@primer/web"]]`
   (recommended).** The SPA ships only inside the API image; without the group a
   `@primer/web`-only changeset tags `@primer/web@x` (no Dockerfile → no image)
   and the fix never deploys. Alternative: a convention that every web changeset
   also names the API package — unenforced, will be forgotten. Side effect: both
   packages take the same version from the next release onward (both are 0.1.0
   today, so no jump).
4. **`/health-check` body carries `gitSha`/`builtAt` (recommended)** sourced
   from the shared pipeline's `GIT_SHA`/`BUILT_AT` build-args — this is the
   version probe `verify-release` needs and avoids touching `index.ts` (which
   #109 edits). Alternative: bare `{ ok: true }` and log the identity at boot.
5. **Keep `bumpVersionsWithWorkspaceProtocolOnly: true` (recommended).** The
   team standard says `false` so Docker builds at tags install npm-published
   libraries; Primer's image is built from the workspace at the tag and bundles
   `primer-api-types` from source (esbuild), so the deviation documented in
   `.changeset/README.md` still holds — its wording (which cites Railway) is
   updated in S0.
6. **Keep #108's digest-pinned `node:24-bookworm-slim` via `ARG NODE_IMAGE`
   (recommended).** Stricter than the standard's bare tag; bumps are deliberate.
7. **Keep migrations in the container `CMD` (as #108) (recommended for now).**
   Single replica, drizzle migrator is transactional; a Kubernetes Job is the
   long-term shape and is a dry-dock follow-up, not this PR.
8. **CI Postgres for the release test job: GitHub `services:` block mirroring
   `ci.yml` (recommended)** rather than a compose script — declarative, same
   image (`postgres:17.9`), same credentials as CI; the app container reaches
   it via the Docker bridge gateway `172.17.0.1`.
9. **`release.yml` stays bespoke.** Its header explains why Primer cannot use
   `apps-npm-release.yml` (plugin.json mirroring); only its stale second
   paragraph (Railway auto-deploy rationale) is rewritten.

## Relationship to #108 / #109 / #110 / #111

- **#108** is superseded: this PR carries the Dockerfile (moved to
  `apps/api/`), `.dockerignore`, and a `test`+`release` trigger instead of
  `release-image.yml`. The PR body states `Supersedes #108 · Closes #104 · Part
  of #103`. Closing #108 is a human action after this PR opens; nothing here
  comments on it.
- **#109 (GCS storage)** and **#110 (`/api/ready`)** are independent code
  changes that the image should contain; this PR merges after them (P4) and
  rebases. The smoke suite asserts `/api/ready` (from #110); the CI container
  runs with the default filesystem storage (`STORAGE_ROOT=/tmp/primer-storage`),
  so #109's GCS path is not exercised in CI (it needs Workload Identity).
- **#111 (cutover runbook)** is docs; after this PR the "first image tag" it
  references is a semver tag, and the Version Packages merge is the release step.

## Implementation Graph

```mermaid
flowchart TD
  S0[Stage S0: Package identity and changesets config]
  S1A[Stage S1A: /health-check liveness route]
  S1B[Stage S1B: Dockerfile, .dockerignore, changeset]
  S2[Stage S2: Container smoke suite and local simulation]
  S3[Stage S3: Docker release trigger workflow and docs]
  S4[Stage S4: Test plan — full verification]
  S5[Stage S5: Team-lead review, rebase, draft PR]
  S0 --> S1A
  S0 --> S1B
  S1A --> S2
  S1B --> S2
  S2 --> S3
  S3 --> S4
  S4 --> S5
```

```json make-it-so-stage-index
{
  "version": 2,
  "stages": [
    {
      "id": "S0",
      "name": "Package identity and changesets config",
      "dependsOn": [],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": [
        "apps/api/package.json",
        "package.json",
        ".changeset/config.json",
        ".changeset/README.md",
        ".changeset/clear-audit-advisories.md",
        ".changeset/js-yaml-merge-key-dos.md",
        ".changeset/undo-comment-deletes.md",
        "apps/api/CHANGELOG.md",
        "README.md",
        "apps/api/src/app.ts",
        "apps/api/src/companion/MERMAID.md",
        "apps/api/src/companion/consent.browser.test.ts",
        "apps/api/src/companion/events.consent.test.ts"
      ],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S1A",
      "name": "/health-check liveness route",
      "dependsOn": ["S0"],
      "parallelism": "PARALLEL",
      "dispatch": "wave",
      "files": [
        "apps/api/src/routes/health.ts",
        "apps/api/src/routes/health.test.ts",
        "apps/api/src/middleware/auth.ts"
      ],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S1B",
      "name": "Dockerfile, .dockerignore, changeset",
      "dependsOn": ["S0"],
      "parallelism": "PARALLEL",
      "dispatch": "wave",
      "files": [
        "apps/api/Dockerfile",
        ".dockerignore",
        ".changeset/team-standard-container-image.md"
      ],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S2",
      "name": "Container smoke suite and local simulation",
      "dependsOn": ["S1A", "S1B"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": [
        "apps/api/container-tests/smoke.test.ts",
        "apps/api/vitest.config.ts",
        "apps/api/tsconfig.json",
        "scripts/container-smoke.sh"
      ],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S3",
      "name": "Docker release trigger workflow and docs",
      "dependsOn": ["S2"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": [
        ".github/workflows/docker-release-trigger.yml",
        ".github/workflows/release.yml",
        "README.md"
      ],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S4",
      "name": "Test plan — full verification",
      "dependsOn": ["S3"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": [],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S5",
      "name": "Team-lead review, rebase, draft PR",
      "dependsOn": ["S4"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": ["plans/team-standard-docker-release.md"],
      "owner": "team-lead",
      "costExpectation": "minutes",
      "model": "opus"
    }
  ]
}
```

## Local test infrastructure (used by several stages)

Every stage that runs the in-process suite or boots the image needs a local
Postgres. The vitest config hard-codes `postgres://primer:primer@localhost:5432/primer_test`
while `docker-compose.yml` defaults the password to `primer_local_dev`, so start
Compose with the CI password **on a fresh volume**:

```bash
docker compose down -v
POSTGRES_PASSWORD=primer docker compose up -d --wait postgres
DATABASE_URL_TEST=postgres://primer:primer@localhost:5432/primer_test pnpm db:migrate:test
```

A container reaches that Postgres at `host.docker.internal:5432` on Docker
Desktop (macOS) and at `172.17.0.1:5432` on Linux — the same bridge-gateway
address the CI job uses. `scripts/container-smoke.sh` (S2) takes the host as
its first argument, exactly like the template's `start-integration-resources.sh`.

The environment a booted image needs (identical in CI and locally; values are
placeholders — Okta discovery is lazy and never contacted by the smoke suite):

| Var | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://primer:primer@<host>:5432/primer` | migrations + readiness |
| `AUTH_MODE` | `okta` | `mock` is refused under `NODE_ENV=production` |
| `OKTA_ISSUER` | `https://okta.invalid` | required by boot; discovery lazy |
| `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET` | `ci` | required by boot |
| `AUTH_BASE_URL` | `http://localhost:3000` | required by boot; http keeps cookies non-secure |
| `STORAGE_ROOT` | `/tmp/primer-storage` | `/app/api` is root-owned; filesystem backend must be writable |
| `LOG_LEVEL` | `info` | readable container logs on failure |

## Stage S0: Package identity and changesets config

Why first: every later stage names the package (`pnpm --filter primer`, the
Dockerfile's `--filter`, the changeset, the trigger's `workflow_dispatch`
example). Renaming after they exist means touching them twice.

- [ ] **Action**: Rename the API package from `@primer/api` to `@polygonlabs/primer` (keep `"version"`, `"private": true` and every script).
  - **Files**: apps/api/package.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `node -e "const p=require('./apps/api/package.json'); if(p.name!=='@polygonlabs/primer'||p.private!==true) process.exit(1)"` → exit 0
- [ ] **Action**: Rename the repo-root package from `primer` to `primer-workspace` and update the five root scripts that use `--filter @primer/api` (`start`, `db:migrate`, `db:migrate:test`, `db:generate`, `db:purge`) to `--filter @polygonlabs/primer`.
  - **Files**: package.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter primer exec -- node -e "process.stdout.write(process.cwd())"` → prints exactly `<repo-root>/apps/api` (one line, not the repo root)
- [ ] **Action**: Add the changesets `fixed` group so the SPA and the API version together: `"fixed": [["@polygonlabs/primer", "@primer/web"]]`. Leave every other key as is (including `bumpVersionsWithWorkspaceProtocolOnly: true`, Open decision 5).
  - **Files**: .changeset/config.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm exec changeset status` → exit 0 (no "package not found"; lists pending releases)
- [ ] **Action**: Rewrite every pending changeset front-matter line `"@primer/api": <bump>` to `"@polygonlabs/primer": <bump>`. At execution time glob `.changeset/*.md` — more files may exist than the three listed if #109/#110 have merged (P4) — and include each one touched in the stage report's `filesChanged`.
  - **Files**: .changeset/clear-audit-advisories.md, .changeset/js-yaml-merge-key-dos.md, .changeset/undo-comment-deletes.md
  - **Owner**: Implementation agent: backend
  - **Verify**: `git grep -l '@primer/api' -- .changeset` → no output
- [ ] **Action**: Update `.changeset/README.md`: replace the `@primer/api` mention and rewrite the sentence "Primer has no such build — the Railway app installs from the repo" to state the current truth: the container image is built from the workspace at the release tag (`apps/api/Dockerfile`, frozen lockfile) and bundles `primer-api-types` from source, so in-repo installs must keep resolving workspace packages locally. Explain the new `fixed` group in one sentence (the SPA ships only inside the API image).
  - **Files**: .changeset/README.md
  - **Owner**: Implementation agent: backend
  - **Verify (manual)**: Read `.changeset/README.md`; it names `@polygonlabs/primer`, does not mention Railway, and explains both the `bumpVersionsWithWorkspaceProtocolOnly` deviation and the `fixed` group in terms of the Docker build.
- [ ] **Action**: Update the remaining textual references: `apps/api/CHANGELOG.md` H1 (`# @polygonlabs/primer` — history below it is untouched), `README.md` line referencing `pnpm --filter @primer/api test:browser`, the `app.ts` comment near `STATIC_ROOT` (drop the "Railway runs …" clause; keep the "regardless of cwd" rationale), and the three `apps/api/src/companion/*` comments/docs. Do not touch `plans/dissolve-primer-shared.md` or `docs/` (historical).
  - **Files**: apps/api/CHANGELOG.md, README.md, apps/api/src/app.ts, apps/api/src/companion/MERMAID.md, apps/api/src/companion/consent.browser.test.ts, apps/api/src/companion/events.consent.test.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `git grep -n '@primer/api' -- . ':!pnpm-lock.yaml' ':!**/CHANGELOG.md' ':!plans/**' ':!docs/**'` → no output
- [ ] **Action**: Prove the rename is lockfile-neutral and the workspace still resolves.
  - **Files**: package.json, apps/api/package.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm install --frozen-lockfile && git diff --exit-code -- pnpm-lock.yaml && pnpm typecheck` → exit 0 with no lockfile diff

## Stage S1A: /health-check liveness route

The `docker-test` action polls `/health-check` and nothing else; the team
Monitoring standard names it as the Kubernetes liveness path. Build identity
rides on it (Open decision 4) because the shared pipeline passes `GIT_SHA` /
`BUILT_AT` build-args and nothing else in Primer exposes a version.

Assumes #110 has merged (P4): `apps/api/src/routes/health.ts` exists with
`registerHealthRoutes`. **Fallback** if it has not: add the route beside
`app.get('/api/health', …)` in `apps/api/src/app.ts` and the test cases in a new
`apps/api/src/routes/healthCheck.test.ts`; report the deviation and the changed
file set (S1A then shares `app.ts` with S0's comment edit — still sequential
after S0, so no conflict).

- [ ] **Action**: Register `GET /health-check` in `registerHealthRoutes` returning `200 { ok: true, gitSha, builtAt }` where `gitSha = process.env.GIT_SHA ?? 'unknown'` and `builtAt = process.env.BUILT_AT ?? 'unknown'`. No DB access (liveness must not depend on the database — that is `/api/ready`'s job). Add a one-line comment saying why the endpoint exists (shared `docker-test` action + k8s liveness) and why it carries build identity.
  - **Files**: apps/api/src/routes/health.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `grep -n "'/health-check'" apps/api/src/routes/health.ts` → one match
- [ ] **Action**: Add `'/health-check'` to `PUBLIC_PATHS` so the kubelet, the GCP load balancer and the CI poller (no credentials) get 200 rather than a 302 to `/auth/login`.
  - **Files**: apps/api/src/middleware/auth.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `grep -n "'/health-check'" apps/api/src/middleware/auth.ts` → one match
- [ ] **Action**: Add tests to `health.test.ts` using its existing `withApp` helper and anonymous resolver: (a) `GET /health-check` → 200 and body `{ ok: true, gitSha: 'unknown', builtAt: 'unknown' }` when the env vars are unset (use `vi.stubEnv`/restore so the suite's env is untouched); (b) with `GIT_SHA=abc1234` and `BUILT_AT=2026-01-01T00:00:00Z` stubbed → body echoes them; (c) the route is reachable with no session (the anonymous resolver already proves this — assert status is 200, not 302).
  - **Files**: apps/api/src/routes/health.test.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter primer exec vitest run src/routes/health.test.ts` → all tests pass, 0 failed (needs the local Postgres from "Local test infrastructure")
- [ ] **Action**: Keep the whole in-process suite green.
  - **Files**: apps/api/src/routes/health.ts, apps/api/src/middleware/auth.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter primer test` → `Test Files  <N> passed` with 0 failed and `pnpm typecheck` → exit 0

## Stage S1B: Dockerfile, .dockerignore, changeset

Takes #108's verified Dockerfile as the base and makes four changes: location
(`apps/api/Dockerfile`, because the action gates on `${PKG_DIR}/Dockerfile`;
context stays the repo root in both the action and the GCP pipeline), no
`--platform=$BUILDPLATFORM` (each platform now builds on a native runner —
pipelines#71 — so the native-addon caveat and the cross-build stage go away),
`npm install -g pnpm@<packageManager version>` instead of `corepack enable`
(template-aligned, deterministic, no network-fetched toolchain at build time),
and `--ignore-scripts` on install (team Dockerfile standard; Primer's
`pnpm-workspace.yaml` already allowlists only `esbuild`, whose platform binary
arrives as an optional dependency, so the postinstall is not needed — the build
verify below is what proves it).

- [ ] **Action**: Write `apps/api/Dockerfile` (multi-stage, context = repo root):
  - `ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` (as #108; re-verify the digest resolves — see verify).
  - `build` stage: `WORKDIR /src`; `RUN npm install -g pnpm@11.8.0` (comment: keep in sync with root `packageManager`); `COPY . .`; `RUN pnpm install --frozen-lockfile --ignore-scripts`; `RUN pnpm --filter @polygonlabs/primer-api-types --filter @primer/web --filter @polygonlabs/primer run build`; `RUN pnpm --filter @polygonlabs/primer deploy --prod --legacy /out/api && rm -rf /out/api/src /out/api/scripts /out/api/container-tests /out/api/*.test.* /out/api/vitest*.ts && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist`.
  - `runtime` stage from the same `NODE_IMAGE`: `ARG GIT_SHA=unknown`, `ARG BUILT_AT=unknown`; `ENV NODE_ENV=production SERVE_STATIC=1 STATIC_ROOT=/app/web/dist PORT=3000 GIT_SHA=${GIT_SHA} BUILT_AT=${BUILT_AT}`; `COPY --from=build --chown=root:root /out/api /app/api` and `/out/web /app/web`; `USER node`; `EXPOSE 3000`; `WORKDIR /app/api`; `CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]`.
  - Header comment: why one image (API serves the SPA), why migrations run first, why the context is the repo root and the file lives in `apps/api/`, why `--ignore-scripts` is safe here, that the shared pipeline supplies `GIT_SHA`/`BUILT_AT`.
  - **Files**: apps/api/Dockerfile
  - **Owner**: Implementation agent: backend
  - **Verify**: `docker buildx imagetools inspect node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 >/dev/null && docker buildx build --build-arg GIT_SHA=$(git rev-parse --short HEAD) --build-arg BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) -f apps/api/Dockerfile -t primer:ci --load .` → exit 0
- [ ] **Action**: Write the repo-root `.dockerignore` (context is the root): #108's list (`**/node_modules`, `**/dist`, `.git`, `.env`, `.env.*` but `!.env.example`, `storage`, `apps/api/storage`, `tmp`, `.claude`, `.superpowers`, `.primer`, `coverage`, `**/.vitest-tmp`, `**/.vite`, `**/*.log`) plus `.github`, `docs`, `plans`. Do **not** ignore `plugins/`, `packages/` or `apps/mcp` — `pnpm install --frozen-lockfile` needs every workspace `package.json` the lockfile's importers list. Add a comment saying so.
  - **Files**: .dockerignore
  - **Owner**: Implementation agent: backend
  - **Verify**: `docker run --rm primer:ci sh -c 'test ! -e /app/api/src && test ! -e /app/api/.env && test ! -d /app/api/node_modules/.pnpm/tsx* && test -d /app/api/drizzle && test -f /app/api/dist/companion/v1.js && test -f /app/web/dist/index.html && test "$(id -u)" = 1000 && echo OK'` → prints `OK`
- [ ] **Action**: Boot the image against the local Postgres with the env table from "Local test infrastructure" (`DATABASE_URL` host `host.docker.internal` on macOS, `172.17.0.1` on Linux) and confirm migrations + listening + SPA. (Use `/api/health` here; `/health-check` lands in S1A and is asserted in S2.)
  - **Files**: apps/api/Dockerfile
  - **Owner**: Implementation agent: backend
  - **Verify**: `docker rm -f primer-ci >/dev/null 2>&1; docker run -d --name primer-ci -p 3000:3000 -e PORT=3000 -e DATABASE_URL=postgres://primer:primer@host.docker.internal:5432/primer -e AUTH_MODE=okta -e OKTA_ISSUER=https://okta.invalid -e OKTA_CLIENT_ID=ci -e OKTA_CLIENT_SECRET=ci -e AUTH_BASE_URL=http://localhost:3000 -e STORAGE_ROOT=/tmp/primer-storage -e LOG_LEVEL=info primer:ci && for i in $(seq 1 30); do curl -sf http://localhost:3000/api/health >/dev/null && break; sleep 1; done; curl -sf http://localhost:3000/api/health && curl -sf http://localhost:3000/ | grep -q 'id="root"' && docker logs primer-ci 2>&1 | grep -q 'Migrations applied' && echo BOOT_OK; docker rm -f primer-ci >/dev/null` → prints `{"ok":true}` then `BOOT_OK`
- [ ] **Action**: Add the changeset for the shippable change (this stage introduces the artifact that gets released): `"@polygonlabs/primer": patch`, plain-prose first line, user-facing wording, no internal incident narrative. Suggested body: "Ship Primer as a versioned container image. Every release of `@polygonlabs/primer` now builds a multi-architecture image tagged with the release version; the API serves the built web app from the same image, runs pending database migrations on start, and answers `GET /health-check` with its build identity (`gitSha`, `builtAt`)."
  - **Files**: .changeset/team-standard-container-image.md
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm exec changeset status` → exit 0 and output lists `@polygonlabs/primer` under packages to be bumped

## Stage S2: Container smoke suite and local simulation

The action's test step is fixed: `TEST_BASE_URL=http://localhost:3000 pnpm --filter primer test`.
Primer's `test` script is `vitest run`, whose 72 files import the app in-process
and truncate a local database — they cannot target a container and must not be
rewritten for this change. So `vitest.config.ts` selects a different, tiny
suite when `TEST_BASE_URL` is set; the default `pnpm test` is byte-for-byte the
same run as today. This is a declared deviation from the template, where the
same tests run in both modes; the deviation is recorded in the config comment.

- [ ] **Action**: Switch `apps/api/vitest.config.ts` on `process.env.TEST_BASE_URL`: when set, `include: ['container-tests/**/*.test.ts']`, `environment: 'node'`, no `setupFiles`, no `env.DATABASE_URL`; when unset, the existing config unchanged. Comment: why (shared `docker-test` contract, suite shape), and that the container suite lives outside `src/` so the default glob can never pick it up.
  - **Files**: apps/api/vitest.config.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter primer test 2>&1 | grep -E 'Test Files'` → the same file count as before this stage (72 on `99c994d`; re-count with `git ls-files 'apps/api/src/**/*.test.ts' | grep -vc browser` at execution time) and 0 failed
- [ ] **Action**: Add `apps/api/container-tests/` to `tsconfig.json` `include` so `pnpm typecheck` covers the smoke suite.
  - **Files**: apps/api/tsconfig.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter primer typecheck` → exit 0
- [ ] **Action**: Write `apps/api/container-tests/smoke.test.ts` using global `fetch` against `process.env.TEST_BASE_URL` (throw at module load if unset — this file only ever runs in container mode). Cases, each a separate `it`:
  1. `GET /health-check` → 200, `content-type` JSON, body `{ ok: true, gitSha: <non-empty string>, builtAt: <non-empty string> }`;
  2. `GET /api/health` → 200 `{ ok: true }`;
  3. `GET /api/ready` → 200 `{ ok: true }` (migrations ran and the DB is reachable from inside the container; from #110 — if #110 is not on the branch, report blocked rather than deleting the case);
  4. `GET /` → 200, `text/html`, body contains `id="root"` (SPA served: `SERVE_STATIC=1`, `STATIC_ROOT` valid);
  5. parse the first `/assets/*.js` `src` from that HTML, `GET` it → 200 with a JavaScript `content-type` (Vite build present at the static root);
  6. `GET /companion/v1.js` → 200 (the build script's copy step);
  7. `GET /api/me` with no credentials → 401 (auth gate active under `AUTH_MODE=okta`, `NODE_ENV=production`);
  8. `GET /auth/mock` → 404 (mock-auth routes are not registered in a production image);
  9. `GET /nope` → 404 or 302 but never 500 (the SPA fallback does not mask a missing `index.html`; a 500 `SPA build missing` means `STATIC_ROOT` is wrong).
  Use Chai-style assertions per team standard (`expect(res.status).equal(200)`, `.property('ok', true)`), no `.to.be` chains.
  - **Files**: apps/api/container-tests/smoke.test.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `scripts/container-smoke.sh host.docker.internal` (below) → exits 0 with `Tests  9 passed`
- [ ] **Action**: Write `scripts/container-smoke.sh <db-host>` — the local simulation of the CI `test` job, step for step as the `docker-test` action does it: build `primer:ci` from `apps/api/Dockerfile` with the repo-root context (pass `GIT_SHA`/`BUILT_AT` build-args from `git rev-parse --short HEAD` / `date -u`), `docker run -d --name primer-ci -p 3000:3000 -e PORT=3000` plus the env table from "Local test infrastructure" with `DATABASE_URL` using `<db-host>` (default `host.docker.internal`; use `172.17.0.1` on Linux), poll `/health-check` 30×1s, run `TEST_BASE_URL=http://localhost:3000 pnpm --filter primer test`, and always `docker logs` + stop + rm (trap). `set -euo pipefail`; comment header explains it mirrors `0xPolygon/pipelines/.github/actions/docker-test` so a release-gate failure can be reproduced locally, and that Postgres must already be up (`POSTGRES_PASSWORD=primer docker compose up -d --wait postgres`).
  - **Files**: scripts/container-smoke.sh
  - **Owner**: Implementation agent: backend
  - **Verify**: `chmod +x scripts/container-smoke.sh && scripts/container-smoke.sh host.docker.internal` → exit 0, prints `Service ready` and the vitest summary with 0 failed

## Stage S3: Docker release trigger workflow and docs

A thin trigger, copied from `apps-team-ts-template/.github/workflows/docker-release-trigger.yml`
and adapted only where Primer differs: a Postgres service container and the
boot env for the image. No shell logic in YAML.

- [ ] **Action**: Write `.github/workflows/docker-release-trigger.yml`:
  - `on.push.tags: ['*@[0-9]*', '*/*@[0-9]*']` (comment as in the template: scoped tags contain `/`; non-Docker packages — `primer-mcp`, `primer-api-types`, `plugin-primer`, `web` — no-op because they have no Dockerfile; never maintain a per-package list) and `workflow_dispatch.inputs.tag` (example `@polygonlabs/primer@0.2.0`).
  - top-level `permissions: { contents: read, id-token: write }` (superset of `apps-docker-release.yml`'s job permissions).
  - job `test` on `ubuntu-latest` with `services.postgres` identical to `ci.yml`'s block (`postgres:17.9`, user/password `primer`, `POSTGRES_DB: primer`, port `5432:5432`, `pg_isready` health options) and a `job.env:` block holding exactly the table from "Local test infrastructure" with `DATABASE_URL: postgres://primer:primer@172.17.0.1:5432/primer`; one step `id: docker-test` using `0xPolygon/pipelines/.github/actions/docker-test@main` with `tag: ${{ inputs.tag || '' }}` and `test_vars: DATABASE_URL AUTH_MODE OKTA_ISSUER OKTA_CLIENT_ID OKTA_CLIENT_SECRET AUTH_BASE_URL STORAGE_ROOT LOG_LEVEL`; the five `outputs` mapped from the step as in the template. Comment why `172.17.0.1` (the app container reaches the runner-published port through the Docker bridge gateway; `localhost` inside the container is the container) and why Okta placeholders are safe (discovery is lazy; the smoke suite never triggers login).
  - job `release` with `needs: test`, `if: needs.test.outputs.should_build == 'true'`, `uses: 0xPolygon/pipelines/.github/workflows/apps-docker-release.yml@main`, the four `with:` inputs from `needs.test.outputs`, and `secrets: build_params_gh_secret_keys: ${{ secrets.build_params_gh_secret_keys }}` (explicit by name — never `secrets: inherit`).
  - **Files**: .github/workflows/docker-release-trigger.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color .github/workflows/docker-release-trigger.yml` → exit 0, no findings
- [ ] **Action**: Prove the trigger's `test_vars` and `job.env` agree and match the local script: every name in `test_vars` is a key under `jobs.test.env`, and `scripts/container-smoke.sh` passes the same names with `-e`.
  - **Files**: .github/workflows/docker-release-trigger.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `for v in $(sed -n 's/.*test_vars: *//p' .github/workflows/docker-release-trigger.yml); do grep -qE "^ {6}$v:" .github/workflows/docker-release-trigger.yml && grep -q -- "-e $v" scripts/container-smoke.sh || { echo "MISSING $v"; exit 1; }; done; echo VARS_OK` → prints `VARS_OK`
- [ ] **Action**: Rewrite the second header paragraph of `release.yml` (the one justifying "does NOT auto-merge the Version Packages PR" by Railway auto-deploying from master). New truth: merging the Version Packages PR is the release — it publishes npm packages, pushes the release tags, and the `@polygonlabs/primer@X.Y.Z` tag triggers `docker-release-trigger.yml`, which tests and publishes the image Kargo then promotes manually; so the PR stays the deliberate human gate for the service image, the npm packages and the plugin content together. Nothing else in the file changes.
  - **Files**: .github/workflows/release.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `grep -c -i railway .github/workflows/release.yml` → `0`; `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest .github/workflows/release.yml` → exit 0
- [ ] **Action**: Add a short "Container image and releases" section to `README.md` (why-level, no file listings): releases are cut by merging the Version Packages PR; the `@polygonlabs/primer` tag builds, tests and publishes the versioned image through the team's shared pipelines workflows; deployment is dry-dock/Kargo; `scripts/container-smoke.sh` reproduces the release gate locally. Link `apps/api/Dockerfile` and `.github/workflows/docker-release-trigger.yml` by path.
  - **Files**: README.md
  - **Owner**: Implementation agent: ci
  - **Verify**: `grep -n 'container-smoke.sh' README.md` → one match

## Stage S4: Test plan — full verification

Runs everything end to end on the assembled branch. Unit and integration tests
were written in S1A and S2; this stage proves they hold together, exercises the
amd64 leg the shared pipeline will build on its own runner, and re-checks the
machine gates the PR will face. No files change; a failure here is a plan or
stage defect routed back to the team lead.

- [ ] **Action**: In-process suite, typecheck, build and plugin-version drift check — the same gates as `ci.yml`.
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `pnpm install --frozen-lockfile && pnpm run codegen-drift-check && pnpm typecheck && pnpm -r run build && pnpm test` → exit 0, 0 failed
- [ ] **Action**: Release-gate simulation (arm64, the architecture production runs) via the local script.
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `scripts/container-smoke.sh host.docker.internal` → exit 0, `Tests  9 passed`
- [ ] **Action**: amd64 build of the same Dockerfile (emulated locally — slow, several minutes; this is the only pre-merge check of the leg the GCP pipeline builds natively).
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `docker buildx build --platform linux/amd64 -f apps/api/Dockerfile -t primer:ci-amd64 . && docker run --rm --platform linux/amd64 primer:ci-amd64 node -e "console.log(process.arch)"` → prints `x64`
- [ ] **Action**: Changeset and naming gates the PR will face.
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `pnpm exec changeset status --since=origin/master && ! git grep -q '@primer/api' -- . ':!pnpm-lock.yaml' ':!**/CHANGELOG.md' ':!plans/**' ':!docs/**' && echo GATES_OK` → prints `GATES_OK`
- [ ] **Action**: Workflow lint across the whole `.github/workflows/` tree (the new trigger plus the edited `release.yml`).
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color` → exit 0

Monitoring verification stage: omitted — research found no monitored signals
(no Grafana dashboards or alerts reference Primer yet; see Research findings).

## Stage S5: Team-lead review, rebase, draft PR

- [ ] **Action**: Rebase `feat/team-standard-docker-release` onto fresh `origin/master` (after #109/#110 merge per P4 — if they have not, decide: wait, or execute the S1A/S2 fallbacks and note it in the PR). Re-run the S4 verify commands post-rebase. Re-glob `.changeset/*.md` for `@primer/api` (S0's fourth item) — #109/#110 bring changesets named for the old package.
  - **Files**: plans/team-standard-docker-release.md
  - **Owner**: Team lead
  - **Verify**: `git -C <worktree> log --oneline origin/master..HEAD` → one commit per completed stage plus the genesis commit, nothing else; `pnpm exec changeset status --since=origin/master` → exit 0
- [ ] **Action**: Review every stage diff against its declared file set; tick the boxes; open the **draft** PR with this plan's Motivation as the body plus the lines `Supersedes #108 · Closes #104 · Part of #103`, the Open decisions as resolved, and the Prerequisites (P1–P3) as a "Before the first release" checklist. Relay P2 (semver warehouse) to Taylan for dry-dock#1445. Do not close #108 from the agent; that is the humans' call once this PR is up.
  - **Files**: plans/team-standard-docker-release.md
  - **Owner**: Team lead
  - **Verify (manual)**: `gh -R 0xPolygon/primer pr view <n> --json isDraft,body` shows `isDraft: true` and the body contains "Supersedes #108" and "Before the first release".

## Risks the reviewer should look hardest at

1. **The rename ripple.** `@primer/api` → `@polygonlabs/primer` touches pending
   changesets, and #109/#110 add more. A changeset naming the old package
   fails `changeset status`, the pre-PR gate and the Version Packages run. S0
   and S5 both re-glob, but the race with sibling merges is real (P4).
2. **`--ignore-scripts` + esbuild.** Primer builds with esbuild (not tsc).
   esbuild's platform binary is an optional dependency so the postinstall is
   not load-bearing under pnpm, but S1B's build verify is the proof; if it
   fails, the sanctioned fallback is to drop `--ignore-scripts` (the workspace
   `allowBuilds` already restricts scripts to esbuild) and report the deviation.
3. **Bridge-gateway reachability in CI.** The app container reaches the
   `services:` Postgres at `172.17.0.1:5432` (published on the runner host).
   The template does the same for Compose-published ports; GitHub service
   containers publish the same way. The 30 s `/health-check` poll is the
   detector — the migrate step runs first and fails fast if the DB is
   unreachable, and the action dumps the container logs.
4. **First-release failure modes.** WIF allowlist not yet applied (P1) or the
   secret not visible (P3) fail the `release` job *after* a successful test
   job; recovery is `workflow_dispatch` with the tag — no re-tag, no re-release.
5. **Version coupling via `fixed`.** From the next release `@primer/web` and
   `@polygonlabs/primer` share a version. Intended (one artifact), but it is a
   visible change in `CHANGELOG.md` files and GitHub Releases.
6. **Migrations at pod start** (kept from #108): a second replica or a Kargo
   promotion during a long migration would run `migrate` concurrently; drizzle
   takes a lock, but the long-term shape is a Job (Open decision 7).
7. **`/health-check` under the `polygon-tools` gateway.** If P2's optional
   `gcpHealthCheckRequestPath` change is taken, the HealthCheckPolicy path must
   exist in the deployed image version — deploy this PR's release before
   switching the path.

## Execution prerequisites

- **Branch verification (mandatory).** `git -C /Users/dcollins/apps-team-workspace/repositories/primer/.claude/worktrees/team-standard-deploy fetch origin`; confirm `git -C <that path> branch --show-current` is `feat/team-standard-docker-release`; `git -C <that path> log --oneline origin/master..HEAD` must show the genesis commit (this plan). Use `git -C <absolute-path>` for every git command — never rely on CWD; the workspace guard requires the literal path immediately before `commit`.
- **Base branch is `master`**, not `main` — every `origin/main` reference in the generic skill text reads `origin/master` here (`changeset status --since=origin/master`, `git log origin/master..HEAD`).
- **Execution branch**: `feat/team-standard-docker-release` in the worktree above, branched off `origin/master`. Push it before each wave so `origin/feat/team-standard-docker-release` is current for worktree-isolated agents.
- **Worktree isolation** for the one parallel wave (S1A ∥ S1B): `Agent isolation: "worktree"` with the shell CWD inside `repositories/primer` at spawn (verify `pwd`), or dispatch the two sequentially in one checkout — never two editing agents in one tree. Each isolated agent's first step is `git checkout --detach origin/feat/team-standard-docker-release`, then verify the tip subject matches the expected stage commit; on mismatch report blocked.
- **Install before verify**: fresh worktrees have no `node_modules` — `pnpm install --frozen-lockfile` first. Docker is required on the executing machine (local arm64 is production's architecture).
- **Every stage commit must be repo-green**: `pnpm typecheck && pnpm test` pass at every commit boundary (Primer has no Husky hooks, so this is the lead's discipline, not a hook's).
- **Local Postgres** per "Local test infrastructure" must be up before S1A, S1B, S2 and S4.

## Execution mechanics

Waves, read off the graph: W1 = {S0}; W2 = {S1A, S1B} (parallel, worktree-
isolated, or sequential in one tree); W3 = {S2}; W4 = {S3}; W5 = {S4};
W6 = {S5, team lead}. A multi-stage wave compiles into one ephemeral `Workflow`
call with one `agent()` per stage, `isolation: 'worktree'`, `model` copied
verbatim from the Stage Index, and `schema` = the stage report contract below;
single-stage waves are plain `Agent` dispatches. Briefs are content-keyed: plan
blob hash (`git hash-object plans/team-standard-docker-release.md`), stage id,
base tree hash, the stage's verify commands quoted verbatim, a `READ FIRST:`
mount of the stage section by path and heading, and run-specific data only.
When a wave returns, the team lead cross-checks `filesChanged` against the
stage's file set, reads the diffs, merges worktree branches, re-runs every
verify command, ticks the boxes in this file, and commits — in the main
session. `blocked` or `null` results are adjudicated by the lead (re-dispatch,
pull a slice forward, or amend the plan); never patched inside a workflow.

### Stage report contract

```json
{
  "stage": "Stage N: <Name>",
  "completed": ["<checklist actions finished>"],
  "filesChanged": ["<paths relative to repo root>"],
  "verifyResults": [{ "cmd": "<exact command run>", "pass": true, "output": "<output tail, on failure only>" }],
  "deviations": ["<anything done differently from the checklist, and why>"],
  "blocked": null
}
```

## Team structure

- **Team lead** (main session): owns waves, review, merges, verify re-runs,
  plan ticks, commits, the rebase in S5 and the draft PR. Never delegates a
  merge, rebase or push.
- **Implementation agents** (`general-purpose`, never Explore): edit only their
  declared file set; no `git commit/push/merge/rebase`, no release or
  versioning command (`changeset version`, `changeset publish`); the only git
  mutation is the sanctioned setup detach; report via the contract above, with
  `blocked` set rather than editing outside the file set or weakening a check.
- **Author ≠ judge**: an agent's `pass: true` is necessary, not sufficient; the
  lead's post-merge re-run gates the stage.

## Commit policy

- One commit per completed stage, Conventional Commits, scope `deploy` unless a
  better one fits: `refactor(deploy): package identity and changesets config`,
  `feat(api): /health-check liveness route`, `feat(deploy): Dockerfile,
  .dockerignore, changeset`, `test(deploy): container smoke suite and local
  simulation`, `ci(deploy): docker release trigger workflow and docs`,
  `test(deploy): full verification` (S4 ticks only; if S4 changes no file, fold
  its ticks into S5's commit), `docs(plans): mark team-standard docker release
  executed` (S5).
- The stage commit ticks that stage's boxes in this file and folds reported
  deviations in; the plan at any commit is the progress record.
- Versioning artifact rides with its stage: the changeset lands in S1B's
  commit. No other stage needs one (S0/S1A/S2/S3 are covered by the same
  release; the config-only and workflow-only edits are outside any package).
- Proceeding to execution is the commit permission for the per-stage commits,
  anchored to the user's go-ahead. Pushing the branch between waves (for
  worktree-isolated agents) is part of that permission; opening the PR is not
  — S5 asks.
- No squashing or reorganising within this skill; `/energize` afterwards is the
  user's option.
