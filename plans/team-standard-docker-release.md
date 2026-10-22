# Team-standard semver Docker release for Primer

Status: PLAN (genesis + rulings amendment — no stage executed yet). Supersedes
primer#108. Refs #104.

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
tags; the `@primer/api@X.Y.Z` tag triggers the team's shared `docker-test`
composite action and `apps-docker-release.yml` workflow in `0xPolygon/pipelines`,
which build the image, boot it with a real Postgres, run a smoke suite against
the running container, and only then build and publish the multi-arch (amd64 +
arm64, each on a native runner) image tagged `X.Y.Z`. Kargo subscribes to
semver tags, so the image that reaches production is the one whose version
appears in `apps/api/CHANGELOG.md` and on the GitHub Release — the same
identity every other team service has, and the one the `verify-release`
tooling expects.

Primer does not fit the shared workflow's assumptions out of the box, and this
plan does not paper over that. The `docker-test` action derives the image name
from the release tag's unscoped package name, so `@primer/api` resolves to
`api`; renaming the package was rejected because six open PRs carry
`@primer/api` changesets, so the trigger's `release` job passes
`image_name: primer` literally (the `test` job's `pnpm --filter api test` is
verified to land on `apps/api` alone). The action polls `/health-check`, which
Primer lacks and will not add — `/api/health` (liveness) and `/api/ready`
(readiness) are its contract — so a separate, public-safe draft PR to
`0xPolygon/pipelines` adds a `health_path` input (default `/health-check`, every
existing consumer unchanged) and Primer's trigger passes `/api/health`. The
action runs `pnpm --filter api test` with `TEST_BASE_URL` pointing at the
container, but Primer's 72-file suite imports the app in-process and truncates
a local Postgres; the suite is left intact and a container smoke suite is
selected instead when `TEST_BASE_URL` is set. The SPA ships inside the API
image, so a `@primer/web`-only changeset must still produce an image; a
changesets `fixed` group makes the two packages version together.

The Dockerfile itself keeps what #108 verified (single image: API + built SPA
with `SERVE_STATIC=1`, migrations before the server, digest-pinned
`node:24-bookworm-slim`, pnpm from `corepack` reading the root `packageManager`,
frozen lockfile, `pnpm deploy --prod`, non-root), moved to `apps/api/Dockerfile`
where the action looks for it, with the cross-compilation trick dropped (the
shared pipeline builds each platform natively since pipelines#71).

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
  `/api/health`, and runs a smoke suite over HTTP against the container:
  liveness, readiness (DB reachable), SPA served, static root wired, companion
  asset present, auth gate active under `NODE_ENV=production`, mock routes
  absent. #108 tested nothing after the build.
- **No bespoke workflow to maintain.** `release-image.yml` (136 lines of
  overwrite guards, WIF plumbing, metadata-action config) is replaced by a thin
  trigger (two jobs, no logic) calling shared, SHA-pinned workflows that the
  team already keeps patched. Primer gains native-runner multi-arch builds,
  per-platform layer cache and digest-merge manifest publishing for free.
- **The shared action gets more general, not Primer more special.** The
  `health_path` input lets any service with an existing liveness path adopt the
  release gate without a code change; the default keeps every current consumer
  byte-for-byte identical.
- **Manual re-release without re-tagging.** `workflow_dispatch` with the tag
  name rebuilds a release image from the release commit — the recovery path if
  the first release runs before the WIF allowlist (polygon-infrastructure#2462)
  or the pipelines change has landed.
- **Standards alignment, measurable.** `pnpm install --ignore-scripts` +
  `pnpm deploy --prod` (Dockerfile standard), `docker-release-trigger.yml` with
  `test` → `release (needs: test)` (Release Management standard), explicit
  per-name secrets, explicit `permissions`.
- **Net code: ~−100 lines of workflow YAML vs #108, +1 Dockerfile (moved), +1
  smoke suite (~70 lines), +1 local simulation script, +1 input on the shared
  action.**

## Rulings (2026-10-22)

Decided by the user after review; the plan carries them as standing orders,
not open questions. No open decisions remain.

1. **No package rename.** `@primer/api` and the root package `primer` stay.
   Rationale: open PRs #99, #100, #101, #109, #110 and #113 all carry
   `@primer/api` changesets; a rename would break every one of them. The
   trigger's `release` job passes `image_name: primer` literally (with a
   comment) instead of `needs.test.outputs.image_name`. Verified: with
   `IMAGE_NAME=api` the action's test step `pnpm --filter api test` resolves to
   `apps/api` only (`pnpm --filter api exec -- sh -c 'echo $PWD'` prints exactly
   `<repo>/apps/api`; the package there is `@primer/api`; `primer-api-types`
   and `primer-mcp` do not match the exact unscoped name `api`). The `fixed`
   group is `[["@primer/api", "@primer/web"]]`. The `workflow_dispatch` example
   tag is `@primer/api@x.y.z`.
2. **Health path.** Primer keeps `/api/health` (liveness) and `/api/ready`
   (readiness). No `/health-check` route, no `gitSha`/`builtAt` identity, no
   `GIT_SHA`/`BUILT_AT` wiring in the Dockerfile. Instead: a separate **draft
   PR to `0xPolygon/pipelines`** adds a `health_path` input to
   `.github/actions/docker-test/action.yml`, default `/health-check`, so every
   existing consumer is unchanged; Primer's trigger passes
   `health_path: /api/health`. `pipelines` is **public**: that PR's body carries
   no internal incident, service or infrastructure names and no session links.
   The pipelines PR merging is a prerequisite for the **first Primer release**,
   not for the Primer PR. The smoke suite asserts `/api/health` and
   `/api/ready`.
3. **GCS.** The release test boots the image with filesystem storage. Follow-up
   (not this PR): once #109 honours `STORAGE_EMULATOR_HOST` (being requested of
   Taylan separately), add `fake-gcs-server` as a sibling container,
   `STORAGE_BACKEND=gcs`, and an authenticated upload/read-back smoke.
4. **Repo conventions (Primer `CLAUDE.md` issue workflow), partial.** Branch is
   `issue-104-team-standard-docker-release` (renamed locally with
   `git branch -m`; it had never been pushed). Every stage commit carries
   `Refs #104`; the PR body has `Closes #104`. No label moves and no comments on
   issue #104 (Taylan's issue).
5. **Local Postgres guard.** Before any Compose step, check that port 5432 is
   free; if it is not, report blocked — never stop or remove a container the
   plan did not create. Every Compose command runs with the explicit project
   name `-p primer-deploy-test`, including `down -v`.
6. **Minor fixes.** (a) The Dockerfile installs pnpm via `corepack enable`
   (reads the root `packageManager`), not `npm install -g pnpm@<ver>`.
   (b) Sequencing: the open Version Packages PR #92 must not merge between this
   PR's merge and the apply of polygon-infrastructure#2462 (a tag cut before
   the WIF allowlist exists runs the release job straight into an auth
   failure). (c) #2462's `replication { auto {} }` on the three secrets is a
   known apply risk — org policy `constraints/gcp.resourceLocations` blocks
   automatic replication in `prj-polygonlabs-webapps-prod`; changes have been
   requested on that PR.
7. **Approved as planned:** the `fixed` group; `bumpVersionsWithWorkspaceProtocolOnly: true`
   stays (the image is built from the workspace at the tag and bundles
   `primer-api-types` from source — `.changeset/README.md`'s wording, which
   cites Railway, is updated); #108's digest-pinned `node:24-bookworm-slim` via
   `ARG NODE_IMAGE`; migrations stay in the container `CMD` (single replica,
   drizzle migrator is transactional; a Kubernetes Job is a dry-dock
   follow-up); CI Postgres for the release test job is a GitHub `services:`
   block mirroring `ci.yml`, reached from the app container at `172.17.0.1`;
   `release.yml` stays bespoke (its header explains why Primer cannot use
   `apps-npm-release.yml`) with only its stale Railway paragraph rewritten.

## Execution amendments (2026-10-22, captain re-verify)

Recorded before the first wave, after re-verifying against `origin/master`
`99c994d` (unchanged since planning) and pipelines `origin/main` `f59f304`.
Where an amendment and an earlier section disagree, the amendment wins.

1. **Local Postgres — President's ruling (2026-10-22), supersedes Ruling 5's
   "report blocked" for one container only.** Port 5432 is held by
   `issue-98-postgres-1` (another Primer worktree's Compose Postgres). The
   **team lead** — never a stage agent — may `docker stop issue-98-postgres-1`
   for the duration of database-using steps, runs this plan's own
   `-p primer-deploy-test` Compose Postgres, and **must `docker start
   issue-98-postgres-1` again when done, including on a blocker or abort**.
   Never remove it, never touch its volume, never stop any other container.
   Every stop and restart is reported at the boundary where it happens. Any
   *other* 5432 listener still means BLOCKED (Ruling 5 stands for it).
2. **Who owns the Compose Postgres.** The team lead provisions and tears down
   `primer-deploy-test` around each database-using wave (S1B, S2, S4) and
   restarts `issue-98-postgres-1` between waves. Stage agents never run
   `docker compose up/down` or `docker stop/start`; their guard becomes:
   `docker compose -p primer-deploy-test ps --status running postgres` lists
   the service — otherwise report blocked.
3. **Dispatch shape.** The session's cwd stays at the workspace root (a guard
   hook blocks dispatch from below it), so `isolation: "worktree"` would isolate
   the wrong repo. Every Primer stage is single-agent and sequential, so each
   Primer stage agent works **directly in the execution worktree**; the one
   parallel wave (S1A ∥ S1B) is two plain `Agent` dispatches in different repos
   (S1A in the pipelines worktree the lead creates), so no checkout is ever
   shared. No `Workflow` compilation, no detach step, and no push-before-wave
   (nothing reads `origin/issue-104-…`); the branch is first pushed at S5.
4. **S1A behavioural check moves to the team lead**, run after S1B lands (it
   needs the Primer image). The S1A agent does the first three items.
5. **S2 fallback is active.** #110 (`/api/ready`) and #109 are still open
   drafts. The smoke suite omits case 2 (`/api/ready`); every
   `Tests  8 passed` in S2/S4 reads `Tests  7 passed`. The case is re-added
   when the branch is rebased onto a master that contains #110, and the PR
   body says so.
6. **In-process test file count is 71** (`git ls-files 'apps/api/src/**/*.test.ts' | grep -vc browser`
   on `99c994d`), not 72.
7. **S3 Postgres service.** `ci.yml`'s block uses `POSTGRES_DB: primer_test`,
   but the image's `DATABASE_URL` targets `/primer`. The trigger's
   `services.postgres` mirrors `ci.yml` (image, user/password, port, health
   options) except `POSTGRES_DB: primer` and `--health-cmd "pg_isready -U primer -d primer"`.
8. **S5 has no rebase in this session.** If `origin/master` has moved by S5, the
   lead reports to the Admiral and waits; rebase/force-push happen in the
   Admiral's session. The draft Primer PR is opened by the lead (mission
   authority). P2 is relayed by the Admiral/humans, not by this session.
9. **Review choices (verification shape).** S2 gets an independent `opus`
   review of the vitest mode switch and the smoke suite (the one place a
   mistake silently changes what `pnpm test` runs). After S2 lands a separate
   `sonnet` exerciser runs `scripts/container-smoke.sh` against the real image
   and inspects container logs and image contents against S1B — this also
   covers S1B, so S1B gets no separate code review.
10. **Stage-brief template.** Every stage brief carries: the plan blob hash and
    stage id; `READ FIRST:` the stage section by heading; the declared file set
    (no edits outside it); the stage's verify commands **quoted verbatim** from
    this plan (as amended here); the Postgres guard of amendment 2 when the
    stage needs a DB; no git mutation and no release/versioning commands; the
    report contract; this escape clause verbatim — *"If any instruction in this
    brief conflicts with what you find, stop that part and report and record
    the conflict, with evidence. Do not ship a half-version and do not argue
    around it."* — and: never reference plan coordinates (S2, P4, …) in code
    comments, commit subjects or PR text without saying what they are.
11. **Commit trailer.** Every Primer commit ends with
    `Claude-Session: https://claude.ai/code/session_01Uhxk1ywKnhbabP9j1z5Vpr`;
    no Co-Authored-By. The pipelines commit carries no issue ref and no session
    link (Ruling 2, Commit policy).

12. **Unauthenticated surface of the image (found at the Dockerfile stage, probed
    on the built image).** Under `AUTH_MODE=okta`, every non-public page
    path, `/` included, answers 302 → `/auth/login`. `/auth/mock` answers 401
    (the auth middleware runs before routing), not 404. The SPA is reachable
    unauthenticated by design at `/share/<token>` (external share plane,
    `isExternalSharePath`), served through the `index.html` fallback, and its
    `/assets/*` are public (`isPublicSpaAsset`). So the Dockerfile boot verify
    and smoke cases 3, 7 and 8 use `/share/smoke-probe`, 401 and `/` → 302 as
    amended in place. The shared action's wait loop is `curl -sf` without
    `-L`, so **any status below 400 counts as ready**. That means P0's "gets
    a 302 and fails" was wrong: Primer's `/health-check` 302s, so the wait
    passes vacuously. The pipelines input description now says so.
    Probe: `/`=302, `/share/smoke-probe`=200 html with `id="root"`,
    `/assets/index-*.js`=200 text/javascript, `/favicon.svg`=200,
    `/companion/v1.js`=200, `/api/me`=401, `/auth/mock`=401, `/nope`=302,
    `/api/ready`=401 (#110 absent), `/health-check`=302.

### Escape-clause and unplanned-decision log

(Dated entries appended at stage boundaries.)

- **2026-10-22 — Admiral rulings on the captain's batched questions**
  (reversible): Q1 Primer commits and the Primer PR carry the commissioning
  session link `session_01Uhxk1ywKnhbabP9j1z5Vpr` (not the executing harness's
  own id). Q2 no session trailer or link anywhere in the pipelines commit or PR.
  Q3 if #110 is still unmerged at the final stage, the Primer draft PR opens
  with the 7-case smoke fallback and says so; rebase and the `/api/ready`
  re-add follow the Admiral's rebase. Q4 if the Dockerfile build fails under
  `--ignore-scripts`, take Risk 2's fallback without asking and report it.
- **2026-10-22 — Changesets fixed group:** `config.json` already carried an
  empty `"fixed": []`; its value was replaced rather than a key added (same
  result). No conflicts.
- **2026-10-22 — pipelines health_path input (draft PR 0xPolygon/pipelines#85,
  commit `6478f88`).** ESCAPE CLAUSE (agent): actionlint cannot lint a
  composite `action.yml`. It treats the file as a workflow and exits 1 with
  "jobs section is missing". Substitute check, by the lead: actionlint on a
  throwaway workflow that calls `./.github/actions/docker-test` with
  `health_path` exits 0. The same workflow with a misspelled input exits 1
  ("input is not defined"), falsified. The `HEALTH_PATH` count is 3, not 2,
  because the plan also requires the failure message to print the path.
  Behavioural check (lead): ready after 1s with `/api/health`. The plan's
  `/does-not-exist` negative passed **vacuously** (302 < 400, see amendment
  12), so it was re-run with `/api/does-not-exist` (401), which fails after
  30 attempts. Unplanned decision: the lead rewrote the input's description
  from "2xx = ready" to the real semantics. Agent finding plus lead probe;
  reversible by editing the description.
- **2026-10-22 — Dockerfile stage.** ESCAPE CLAUSE (agent): the boot verify's
  `GET /` → 200 cannot pass, because `/` is behind the Okta gate (302).
  Question: how to prove the SPA is served without authentication? Options:
  (a) accept the 302, (b) use a public SPA route, (c) another `AUTH_MODE`
  (refused in production). Agent proposed (b); the lead confirmed `/share/*`
  is public by design in `auth.ts` and probed it. Choice (b), with smoke
  cases 7 and 8 corrected the same way (amendment 12). Reversible by editing
  the verify text. The build passed with `--ignore-scripts` (Risk 2 fallback
  unused); no `tsx@` in the image's `.pnpm` (0 entries). Lead edit: one
  Dockerfile comment claimed nothing is written to disk at runtime, which is
  false (filesystem storage writes to `STORAGE_ROOT`); it was reworded and
  the image rebuilt and re-verified.
- **2026-10-22 — Admiral ruling (President's standing order 2026-09-16: a
  defect in a PR's own subject is fixed in that PR).** pipelines#85 extended
  with `5638545`: the readiness wait captures `%{http_code}` and accepts only
  a 2xx; redirects are not followed and count as not ready. The input
  description, README and CLAUDE.md say so. Falsified under `bash -e`
  against the real image on a side port: `/api/health` ready after 2s
  (through connection-refused during boot), the 302 path times out with
  `last status 302`, the 401 path with `401`, no container with `000`; all
  exit 1. shellcheck clean. #85's body rewritten whole and states the
  behaviour change for existing callers. P0 reworded to match.
- **2026-10-22 — Container smoke suite and local simulation.** 7 cases (the
  `/api/ready` fallback); in-process suite unchanged at 71 files. The agent
  falsified the smoke suite (case `/api/me` flipped to expect 200 → `1 failed
  | 6 passed`, reverted → `7 passed`). Lead edits after review: the script's
  readiness poll now matches pipelines#85's 2xx-only rule (it had copied the
  old `curl -sf`); the header no longer says the DB must be "migrated-to-empty".
  **Independent `opus` review** (author ≠ judge): SHIP-WITH-FIXES.
  - Should-fix #1: the `/auth/mock` → 401 case is vacuous for its stated claim.
    The middleware 401s every unauthenticated `/auth/*` before routing, so it
    cannot detect mock routes. Options: delete it, or rename it to what it
    proves. Reviewer and lead agreed: keep it renamed "rejects unauthenticated
    `/auth/*` with 401", since it exercises a distinct branch of the gate.
    `NODE_ENV=production` in the Dockerfile is the actual guarantee.
    Reversible by deleting the case.
  - Nits taken: a one-line notice when `TEST_BASE_URL` flips vitest into
    container mode (the variable is also the team's prod-smoke name); the
    script header now says it mirrors the action as amended by pipelines#85,
    and that it migrates the target DB; the trap is armed after the build.
  - Nit not taken (pre-existing): `vitest.config.ts` is outside any tsconfig
    `include`.
  **Exerciser** (`sonnet`), against the real image: all 5 items PASS, no
  defects. Smoke 7/7; migrations then the listening line; non-root uid 1000;
  `/app` not writable; no devDependencies in `node_modules`; ENV and CMD as
  planned; a second boot on the same DB migrates as a no-op and comes up
  healthy; the unauthenticated probe matches amendment 12; ~419 MB.
  Observations, not fixed here:
  - `/app/api` also carries `Dockerfile`, `CHANGELOG.md`, `drizzle.config.ts`
    and `tsconfig.json` (harmless; could join the Dockerfile's `rm -rf`).
  - Postgres NOTICEs from `migrate.js` print as raw objects, not pino JSON.
  - The server logs every request at info.
  - Mailgun's "env incomplete" WARN appears on each boot (expected with this
    env).

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
     → `@primer/api@0.2.0` gives `image_name=api`, `image_tag=0.2.0`. The
     Primer trigger ignores `image_name` and passes `primer` to the release
     workflow (Ruling 1);
  3. `PKG_DIR=$(pnpm --filter "$SERVICE" exec -- node -e 'process.cwd()')`;
     skips (`should_build=false`) unless **`${PKG_DIR}/Dockerfile` exists** —
     so the Dockerfile must live in `apps/api/`, not the repo root where #108
     put it. (The ops doc `service-deployment.md` still describes a
     `"dockerfile"` package.json field; the action on `main` does not read one —
     doc drift, noted as a follow-up.)
  4. `docker buildx build -f apps/api/Dockerfile -t api:ci --load .` —
     **build context is the repo root**, with GHA layer cache;
  5. `docker run -d --name api-ci -p 3000:3000 -e PORT=3000 -e <each
     test_vars name> api:ci` — values come from the trigger job's `env:`;
  6. `pnpm install --frozen-lockfile` on the runner;
  7. polls **`http://localhost:3000/health-check`** 30×1s (the hard-coded path
     this plan parameterises as `health_path`); dumps logs and fails otherwise;
  8. `TEST_BASE_URL=http://localhost:3000 pnpm --filter api test` — resolves to
     `apps/api` only (verified, Ruling 1);
  9. always: `docker logs`, stop, rm.
- **`apps-docker-release.yml` → `gcp_pipeline_release_image.yaml`** (pipelines
  `origin/main`, pipelines#71 merged): registry
  `europe-west2-docker.pkg.dev/prj-polygonlabs-shared-prod/polygonlabs-docker-prod/<image_name>`,
  tag `type=raw,value=<image_tag>`, `platforms` default
  `linux/amd64,linux/arm64` each built on a native runner (`ubuntu-latest`,
  `ubuntu-24.04-arm`) and pushed by digest, merged into one manifest; passes
  build-args `GIT_SHA` and `BUILT_AT` (a Dockerfile without those `ARG`s just
  logs an unused-build-arg warning); WIF via `shared-prod-oidc-sa` — the same
  pool/SA #108 used by hand. Secret `build_params_gh_secret_keys` is declared
  `required: true` on `apps-docker-release.yml` but the GCP pipeline treats an
  empty value as "no build params". `image_name` is a free-form string input —
  nothing ties it to the tag, which is what makes Ruling 1 safe.
- **`0xPolygon/pipelines` conventions** (for the `health_path` PR): public
  repo, default branch `main`, Conventional Commits enforced by commitlint
  (recent subjects: `fix(claude-autofix): …`, `fix(release): …`); Husky
  `pre-commit` (lint-staged: prettier for `yml`, markdownlint for `md`) and
  `pre-push` (`pnpm exec changeset status --since=origin/main` — passes for
  changes outside `packages/*`, so an action-only change needs no changeset);
  PR checks `apps-ci-trigger.yml` (`./.github/actions/ci`: lint = markdownlint +
  eslint + `prettier --check .`, typecheck, test) and CodeQL. CODEOWNERS routes
  `/.github/actions/docker-test/` to `@0xPolygon/product-applications`. The
  action's inputs are documented in `README.md` ("### `actions/docker-test`")
  and `CLAUDE.md` ("docker-release integration test gate"), both of which say
  "waits for `/health-check`". `pipelines` is not a pinned workspace repo, so
  the explicit-path worktree pattern applies.
- **pnpm filter semantics** (probed): `pnpm --filter api` and
  `--filter @primer/api` → `apps/api`; **`pnpm --filter primer` → the repo
  root** (root `package.json` is `"name": "primer"`). The root is never
  filtered by the action, so this is harmless under Ruling 1; it is why the
  image name is passed literally rather than derived from any package name.
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
  `select 1`, 2s timeout) and the `PUBLIC_PATHS` entry in
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
- **Repo facts**: visibility `internal` (no public-surface PR scrubbing needed
  for the Primer PR); default branch `master`; no `.github/CODEOWNERS`, no
  `.dockerignore`, no Husky hooks; `ci.yml` is bespoke (not the shared `ci`
  composite) — all out of scope here. `gh secret list -R 0xPolygon/primer` shows
  no repo-level secrets, so `CHANGESET_RELEASE_BOT_APP_*` (and presumably
  `build_params_gh_secret_keys`) are org-level. Port 5432 was **in use** on the
  planning machine when probed — Ruling 5's guard will trip there until that
  listener is the operator's to stop.
- **Empty research categories**: no monitored signals (Primer has no Grafana
  dashboards/alerts yet; logs are pino with no named error classes the plan
  touches) → no Monitoring verification stage. Primer is not in the
  apps-team-ops registry (`registry find primer` → no matches) → no
  dependency-graph consumers to notify; registering it is a follow-up.

## Prerequisites (outside the Primer PR — not stages, except P0's PR)

These gate the **first release**, not the Primer PR. The Primer PR can merge
before them; the release workflow is idempotently re-runnable via
`workflow_dispatch` with the tag name once they land.

- **P0 — pipelines `health_path` input merged.** Stage S1A opens the draft PR;
  merging it is the humans' call. Until it merges, the Primer trigger's
  `health_path: /api/health` is an unknown input (GitHub logs a warning and
  ignores it), and the action on `main` polls `/health-check`, which Primer
  answers with a 302 to login. The pre-#85 wait counts any status below 400
  as ready, so it passes vacuously: the smoke suite still runs, but the
  readiness gate itself proves nothing. pipelines#85 (Admiral ruling
  2026-10-22, President's same-PR-fix order) both adds `health_path` and makes
  the wait accept **only a 2xx**. After it merges, a redirecting health path
  fails the gate, and Primer's `/api/health` (200, public) passes it. Hold
  the first release until #85 merges; if a tag lands first, re-run via
  `workflow_dispatch` with the tag after the merge.
- **P1 — WIF push allowlist.** polygon-infrastructure#2462 merged and applied
  (`0xPolygon/primer` under `shared-prod-oidc-sa.github_repos`). Without it the
  `release` job fails at "Authenticate with GCP via OIDC". Known apply risk
  (Ruling 6c): the three secrets use `replication { auto {} }`, which org policy
  `constraints/gcp.resourceLocations` blocks in `prj-polygonlabs-webapps-prod`;
  changes have been requested on that PR. Recovery: re-run via
  `workflow_dispatch` `tag: @primer/api@X.Y.Z`.
- **P2 — dry-dock#1445 switches to semver.** `kargo/projects/web-apps/primer.yaml`
  warehouse: `imageSelectionStrategy: SemVer`, `allowTagsRegexes:
  ['^\d+\.\d+\.\d+$']` (as `gas-station.yaml`); stage file `image.tag` initial
  value = the first published semver tag. Liveness stays `/api/health` and
  readiness `/api/ready` as already written there. Owner: Taylan (his PR) — the
  team lead relays; this plan never comments on another person's PR.
- **P3 — `build_params_gh_secret_keys` reachable from `0xPolygon/primer`.** It
  is an org-level secret on other consumers (`gas-station` passes
  `${{ secrets.build_params_gh_secret_keys }}` exactly as the template does).
  Confirm the org secret's repository access includes `primer` (internal repo).
  If the reusable workflow rejects the call because the secret resolves empty,
  a repo admin adds a repo secret with value `{}`.
- **P4 — Sequencing.** (a) The plan assumes primer#110 (readiness) and #109
  (GCS storage) merge **before** this PR, so `/api/ready` exists for the smoke
  suite; the fallback if not is written into S2. (b) **The open Version Packages
  PR #92 must not merge between this PR's merge and the apply of
  polygon-infrastructure#2462** (Ruling 6b): merging it cuts the first
  `@primer/api` tag, and the release job would run before the allowlist exists.
  Hold #92 until P0 and P1 are done, then merge it as the first release.
- **P5 — Follow-ups (non-blocking):** GCS smoke with `fake-gcs-server` once
  #109 honours `STORAGE_EMULATOR_HOST` (Ruling 3); register Primer in
  `apps-team-ops/src/registry.json` and add a `verify-release` profile
  (`apps-team-ops/docs/runbooks/primer/verify-release.md`); fix the
  `service-deployment.md` drift (`"dockerfile"` field vs Dockerfile-existence
  gate); primer#111's runbook refers to "the first image tag" — semver after
  this.

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
  so #109's GCS path is not exercised in CI (Ruling 3 follow-up).
- **#111 (cutover runbook)** is docs; after this PR the "first image tag" it
  references is a semver tag, and the Version Packages merge is the release step.

## Implementation Graph

```mermaid
flowchart TD
  S0[Stage S0: Changesets fixed group]
  S1A[Stage S1A: pipelines docker-test health_path input]
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
      "name": "Changesets fixed group",
      "dependsOn": [],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": [
        ".changeset/config.json",
        ".changeset/README.md"
      ],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S1A",
      "name": "pipelines docker-test health_path input",
      "dependsOn": ["S0"],
      "parallelism": "PARALLEL",
      "dispatch": "wave",
      "files": [
        "pipelines:.github/actions/docker-test/action.yml",
        "pipelines:README.md",
        "pipelines:CLAUDE.md"
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

File-set convention: paths are relative to the Primer repo root unless prefixed
`pipelines:`, which means relative to the `0xPolygon/pipelines` worktree created
in S1A. The two repos' sets are disjoint by construction.

## Local test infrastructure (used by several stages)

Every stage that runs the in-process suite or boots the image needs a local
Postgres. The vitest config hard-codes `postgres://primer:primer@localhost:5432/primer_test`
while `docker-compose.yml` defaults the password to `primer_local_dev`, so start
Compose with the CI password **on a fresh volume**, under the plan's own
Compose project name so nothing outside this plan is touched (Ruling 5):

Run by the team lead only (Execution amendments 1–2). If the listener is
`issue-98-postgres-1`, the lead first runs `docker stop issue-98-postgres-1`
(President's ruling 2026-10-22) and after the wave `docker compose -p
primer-deploy-test down -v && docker start issue-98-postgres-1`.

```bash
# Guard: port 5432 must be free. If anything is listening, report BLOCKED —
# never stop or remove a container this plan did not create.
if lsof -nP -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1; then echo "BLOCKED: port 5432 in use"; exit 1; fi
docker compose -p primer-deploy-test down -v
POSTGRES_PASSWORD=primer docker compose -p primer-deploy-test up -d --wait postgres
DATABASE_URL_TEST=postgres://primer:primer@localhost:5432/primer_test pnpm db:migrate:test
```

Teardown (only ever this project): `docker compose -p primer-deploy-test down -v`.

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

## Stage S0: Changesets fixed group

The SPA ships only inside the API image. Without a `fixed` group a
`@primer/web`-only changeset tags `@primer/web@x` (no Dockerfile → `docker-test`
skips) and the fix never deploys.

- [x] **Action**: Add `"fixed": [["@primer/api", "@primer/web"]]` to the changesets config. Leave every other key as is (including `bumpVersionsWithWorkspaceProtocolOnly: true`, Ruling 7).
  - **Files**: .changeset/config.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm exec changeset status` → exit 0 (lists pending releases; no config error)
- [x] **Action**: Update `.changeset/README.md`: rewrite the sentence "Primer has no such build — the Railway app installs from the repo" to state the current truth — the container image is built from the workspace at the release tag (`apps/api/Dockerfile`, frozen lockfile) and bundles `primer-api-types` from source, so in-repo installs must keep resolving workspace packages locally; and add one sentence explaining the `fixed` group (the SPA ships only inside the API image, so the two must version together).
  - **Files**: .changeset/README.md
  - **Owner**: Implementation agent: backend
  - **Verify**: `grep -c -i railway .changeset/README.md` → `0`; `grep -c 'fixed' .changeset/README.md` → at least `1`

## Stage S1A: pipelines docker-test health_path input

A change to the shared action in **`0xPolygon/pipelines`** (public), landed as
its own draft PR. Nothing in this stage touches the Primer repo. The default
keeps every existing consumer byte-for-byte unchanged; only consumers that pass
`health_path` see any difference.

Worktree (explicit-path pattern; `pipelines` is not pinned, and this session's
CWD must not move between repos):

```bash
git -C /Users/dcollins/apps-team-workspace/repositories/pipelines fetch origin
git -C /Users/dcollins/apps-team-workspace/repositories/pipelines worktree add /Users/dcollins/apps-team-workspace/repositories/pipelines/.claude/worktrees/docker-test-health-path -b feat/docker-test-health-path origin/main
# verify: git -C <that worktree> log --oneline origin/main..HEAD is empty (fresh branch)
```

Install there before any verify: `pnpm install --frozen-lockfile` (fresh
worktrees have no `node_modules`; Husky's `prepare` wires the hooks).

- [x] **Action**: Add an input to `.github/actions/docker-test/action.yml`: `health_path` — description "Path polled for readiness after the container starts (2xx = ready). Override for services whose liveness endpoint is not `/health-check`." — `required: false`, `default: '/health-check'`. In the "Wait for service to be ready" step, add `HEALTH_PATH: ${{ inputs.health_path }}` to `env:` and change the curl to `curl -sf "http://localhost:${PORT}${HEALTH_PATH}"` (assign via `env:`, never interpolate `${{ }}` into the script — the action's existing injection-protection convention). Update the step's failure message to print the path.
  - **Files**: pipelines:.github/actions/docker-test/action.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color .github/actions/docker-test/action.yml; grep -c 'HEALTH_PATH' .github/actions/docker-test/action.yml` → actionlint exit 0 and the count is `2` (env assignment + curl), run from the pipelines worktree root
- [x] **Action**: Document the input where the action's inputs are documented: `README.md` "### `actions/docker-test`" (one sentence: waits for `health_path`, default `/health-check`; add `# health_path: /api/health` to the YAML example beside `test_vars`) and `CLAUDE.md` "docker-release integration test gate" (replace "waits for `/health-check`" with "waits for `health_path` (default `/health-check`)").
  - **Files**: pipelines:README.md, pipelines:CLAUDE.md
  - **Owner**: Implementation agent: ci
  - **Verify**: `grep -c 'health_path' README.md CLAUDE.md` → both files report at least `1`, run from the pipelines worktree root
- [x] **Action**: Run the repo's own PR gates locally (what `apps-ci-trigger.yml` and the Husky hooks enforce).
  - **Files**: pipelines:.github/actions/docker-test/action.yml, pipelines:README.md, pipelines:CLAUDE.md
  - **Owner**: Implementation agent: ci
  - **Verify**: `pnpm run lint && pnpm run typecheck && pnpm exec changeset status --since=origin/main` → exit 0 (an action-only change is outside `packages/*`, so no changeset is required), run from the pipelines worktree root
- [x] **Action**: Behavioural check of the new loop against a real container: with the Primer image from S1B running locally (any image answering 200 on a non-default path works), run the wait step's shell verbatim with `PORT=3000 HEALTH_PATH=/api/health`, then with `HEALTH_PATH=/does-not-exist` and confirm it fails after 30 attempts.
  - **Files**: pipelines:.github/actions/docker-test/action.yml
  - **Owner**: Implementation agent: ci
  - **Verify (manual)**: Paste the step's `run:` block into a shell with `PORT=3000 HEALTH_PATH=/api/health IMAGE_NAME=primer` against the running `primer-ci` container → prints `Service ready after Ns`; with `HEALTH_PATH=/does-not-exist` → prints the not-ready message and exits 1.
- [x] **Action**: Commit on the pipelines branch (Conventional Commits, e.g. `feat(docker-test): add health_path input for services without /health-check`; commitlint enforces the format), push the branch, and open a **draft** PR. Public-surface rules for the body (Ruling 2): describe the input, its default and that existing consumers are unchanged, plus how it was verified; **no** internal incident IDs, service names, infrastructure names, dry-dock/Kargo detail, or claude.ai session links — the session-link trailer that applies to other repos is deliberately omitted here. Fill the repo's PR template ("New feature", "documentation update").
  - **Files**: pipelines:.github/actions/docker-test/action.yml, pipelines:README.md, pipelines:CLAUDE.md
  - **Owner**: Team lead
  - **Verify (manual)**: `gh -R 0xPolygon/pipelines pr view <n> --json isDraft,body` shows `isDraft: true`, the body mentions `health_path` and its default, and contains none of: `INC-`, `primer`, `dry-dock`, `Kargo`, `claude.ai`.

## Stage S1B: Dockerfile, .dockerignore, changeset

Takes #108's verified Dockerfile as the base and makes four changes: location
(`apps/api/Dockerfile`, because the action gates on `${PKG_DIR}/Dockerfile`;
context stays the repo root in both the action and the GCP pipeline), no
`--platform=$BUILDPLATFORM` (each platform now builds on a native runner —
pipelines#71 — so the native-addon caveat and the cross-build stage go away),
pnpm via `corepack enable` reading the root `packageManager` (Ruling 6a — one
source of truth for the pnpm version), and `--ignore-scripts` on install (team
Dockerfile standard; Primer's `pnpm-workspace.yaml` already allowlists only
`esbuild`, whose platform binary arrives as an optional dependency, so the
postinstall is not needed — the build verify below is what proves it). No
`GIT_SHA`/`BUILT_AT` args (Ruling 2): the pipeline's unused-build-arg warning
is expected and harmless.

- [x] **Action**: Write `apps/api/Dockerfile` (multi-stage, context = repo root):
  - `ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` (as #108; re-verify the digest resolves — see verify).
  - `build` stage: `WORKDIR /src`; `RUN corepack enable` (comment: pnpm version comes from the root `packageManager` field); `COPY . .`; `RUN pnpm install --frozen-lockfile --ignore-scripts`; `RUN pnpm --filter @polygonlabs/primer-api-types --filter @primer/web --filter @primer/api run build`; `RUN pnpm --filter @primer/api deploy --prod --legacy /out/api && rm -rf /out/api/src /out/api/scripts /out/api/container-tests /out/api/*.test.* /out/api/vitest*.ts && mkdir -p /out/web && cp -r apps/web/dist /out/web/dist`.
  - `runtime` stage from the same `NODE_IMAGE`: `ENV NODE_ENV=production SERVE_STATIC=1 STATIC_ROOT=/app/web/dist PORT=3000`; `COPY --from=build --chown=root:root /out/api /app/api` and `/out/web /app/web`; `USER node`; `EXPOSE 3000`; `WORKDIR /app/api`; `CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]`.
  - Header comment: why one image (API serves the SPA), why migrations run first, why the context is the repo root and the file lives in `apps/api/`, why `--ignore-scripts` is safe here.
  - **Files**: apps/api/Dockerfile
  - **Owner**: Implementation agent: backend
  - **Verify**: `docker buildx imagetools inspect node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 >/dev/null && docker buildx build -f apps/api/Dockerfile -t primer:ci --load .` → exit 0
- [x] **Action**: Write the repo-root `.dockerignore` (context is the root): #108's list (`**/node_modules`, `**/dist`, `.git`, `.env`, `.env.*` but `!.env.example`, `storage`, `apps/api/storage`, `tmp`, `.claude`, `.superpowers`, `.primer`, `coverage`, `**/.vitest-tmp`, `**/.vite`, `**/*.log`) plus `.github`, `docs`, `plans`. Do **not** ignore `plugins/`, `packages/` or `apps/mcp` — `pnpm install --frozen-lockfile` needs every workspace `package.json` the lockfile's importers list. Add a comment saying so.
  - **Files**: .dockerignore
  - **Owner**: Implementation agent: backend
  - **Verify**: `docker run --rm primer:ci sh -c 'test ! -e /app/api/src && test ! -e /app/api/.env && test ! -d /app/api/node_modules/.pnpm/tsx* && test -d /app/api/drizzle && test -f /app/api/dist/companion/v1.js && test -f /app/web/dist/index.html && test "$(id -u)" = 1000 && echo OK'` → prints `OK`
- [x] **Action**: Boot the image against the local Postgres (set up per "Local test infrastructure", guard included) with the env table from that section (`DATABASE_URL` host `host.docker.internal` on macOS, `172.17.0.1` on Linux) and confirm migrations + listening + SPA.
  - **Files**: apps/api/Dockerfile
  - **Owner**: Implementation agent: backend
  - **Verify**: `docker rm -f primer-ci >/dev/null 2>&1; docker run -d --name primer-ci -p 3000:3000 -e PORT=3000 -e DATABASE_URL=postgres://primer:primer@host.docker.internal:5432/primer -e AUTH_MODE=okta -e OKTA_ISSUER=https://okta.invalid -e OKTA_CLIENT_ID=ci -e OKTA_CLIENT_SECRET=ci -e AUTH_BASE_URL=http://localhost:3000 -e STORAGE_ROOT=/tmp/primer-storage -e LOG_LEVEL=info primer:ci && for i in $(seq 1 30); do curl -sf http://localhost:3000/api/health >/dev/null && break; sleep 1; done; curl -sf http://localhost:3000/api/health && curl -sf http://localhost:3000/share/smoke-probe | grep -q 'id="root"' && docker logs primer-ci 2>&1 | grep -q 'Migrations applied' && echo BOOT_OK; docker rm -f primer-ci >/dev/null` → prints `{"ok":true}` then `BOOT_OK`
- [x] **Action**: Add the changeset for the shippable change (this stage introduces the artifact that gets released): `"@primer/api": patch`, plain-prose first line, user-facing wording, no internal incident narrative. Suggested body: "Ship Primer as a versioned container image. Every release of `@primer/api` now builds a multi-architecture image tagged with the release version; the API serves the built web app from the same image and runs pending database migrations on start."
  - **Files**: .changeset/team-standard-container-image.md
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm exec changeset status` → exit 0 and output lists `@primer/api` under packages to be bumped

## Stage S2: Container smoke suite and local simulation

The action's test step is fixed: `TEST_BASE_URL=http://localhost:3000 pnpm --filter api test`.
Primer's `test` script is `vitest run`, whose 72 files import the app in-process
and truncate a local database — they cannot target a container and must not be
rewritten for this change. So `vitest.config.ts` selects a different, tiny
suite when `TEST_BASE_URL` is set; the default `pnpm test` is byte-for-byte the
same run as today. This is a declared deviation from the template, where the
same tests run in both modes; the deviation is recorded in the config comment.

Assumes #110 has merged (P4a). **Fallback** if it has not: drop the `/api/ready`
case, report the deviation, and the team lead re-adds it at the S5 rebase.

- [x] **Action**: Switch `apps/api/vitest.config.ts` on `process.env.TEST_BASE_URL`: when set, `include: ['container-tests/**/*.test.ts']`, `environment: 'node'`, no `setupFiles`, no `env.DATABASE_URL`; when unset, the existing config unchanged. Comment: why (shared `docker-test` contract, suite shape), and that the container suite lives outside `src/` so the default glob can never pick it up.
  - **Files**: apps/api/vitest.config.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter api test 2>&1 | grep -E 'Test Files'` → the same file count as before this stage (72 on `99c994d`; re-count with `git ls-files 'apps/api/src/**/*.test.ts' | grep -vc browser` at execution time) and 0 failed
- [x] **Action**: Add `apps/api/container-tests/` to `tsconfig.json` `include` so `pnpm typecheck` covers the smoke suite.
  - **Files**: apps/api/tsconfig.json
  - **Owner**: Implementation agent: backend
  - **Verify**: `pnpm --filter api typecheck` → exit 0
- [x] **Action**: Write `apps/api/container-tests/smoke.test.ts` using global `fetch` against `process.env.TEST_BASE_URL` (throw at module load if unset — this file only ever runs in container mode). Cases, each a separate `it`:
  1. `GET /api/health` → 200, JSON `{ ok: true }` (liveness; the path the action polls via `health_path`);
  2. `GET /api/ready` → 200 `{ ok: true }` (migrations ran and the DB is reachable from inside the container; from #110);
  3. `GET /share/smoke-probe` → 200, `text/html`, body contains `id="root"` (SPA served: `SERVE_STATIC=1`, `STATIC_ROOT` valid; `/share/*` is the external share plane, public by design, and its pages fall back to `index.html` — amendment 12);
  4. parse the first `/assets/*.js` `src` from that HTML, `GET` it → 200 with a JavaScript `content-type` (Vite build present at the static root);
  5. `GET /companion/v1.js` → 200 (the build script's copy step);
  6. `GET /api/me` with no credentials → 401 (auth gate active under `AUTH_MODE=okta`, `NODE_ENV=production`);
  7. `GET /auth/mock` → 401 (the auth gate answers before routing; a production image must never answer 2xx/3xx there — amendment 12);
  8. `GET /` (redirects not followed) → 302 with `location` starting `/auth/login` (pages are behind the Okta gate under `AUTH_MODE=okta` — amendment 12).
  Use Chai-style assertions per team standard (`expect(res.status).equal(200)`, `.property('ok', true)`), no `.to.be` chains.
  - **Files**: apps/api/container-tests/smoke.test.ts
  - **Owner**: Implementation agent: backend
  - **Verify**: `scripts/container-smoke.sh host.docker.internal` (below) → exits 0 with `Tests  8 passed`
- [x] **Action**: Write `scripts/container-smoke.sh <db-host>` — the local simulation of the CI `test` job, step for step as the `docker-test` action does it: build `primer:ci` from `apps/api/Dockerfile` with the repo-root context, `docker run -d --name primer-ci -p 3000:3000 -e PORT=3000` plus the env table from "Local test infrastructure" with `DATABASE_URL` using `<db-host>` (default `host.docker.internal`; use `172.17.0.1` on Linux), poll `/api/health` 30×1s (the `health_path` the trigger passes), run `TEST_BASE_URL=http://localhost:3000 pnpm --filter api test`, and always `docker logs` + stop + rm of `primer-ci` only (trap). `set -euo pipefail`; comment header explains it mirrors `0xPolygon/pipelines/.github/actions/docker-test` so a release-gate failure can be reproduced locally, and that Postgres must already be up (`-p primer-deploy-test`, see the Local test infrastructure section — the script does not start or stop Compose itself).
  - **Files**: scripts/container-smoke.sh
  - **Owner**: Implementation agent: backend
  - **Verify**: `chmod +x scripts/container-smoke.sh && scripts/container-smoke.sh host.docker.internal` → exit 0, prints `Service ready` and the vitest summary with 0 failed

## Stage S3: Docker release trigger workflow and docs

A thin trigger, copied from `apps-team-ts-template/.github/workflows/docker-release-trigger.yml`
and adapted only where Primer differs: a Postgres service container, the boot
env for the image, the `health_path`, and the literal image name. No shell
logic in YAML.

- [ ] **Action**: Write `.github/workflows/docker-release-trigger.yml`:
  - `on.push.tags: ['*@[0-9]*', '*/*@[0-9]*']` (comment as in the template: scoped tags contain `/`; non-Docker packages — `primer-mcp`, `primer-api-types`, `plugin-primer`, `web` — no-op because they have no Dockerfile; never maintain a per-package list) and `workflow_dispatch.inputs.tag` (example `@primer/api@x.y.z`).
  - top-level `permissions: { contents: read, id-token: write }` (superset of `apps-docker-release.yml`'s job permissions).
  - job `test` on `ubuntu-latest` with `services.postgres` identical to `ci.yml`'s block (`postgres:17.9`, user/password `primer`, `POSTGRES_DB: primer`, port `5432:5432`, `pg_isready` health options) and a `job.env:` block holding exactly the table from "Local test infrastructure" with `DATABASE_URL: postgres://primer:primer@172.17.0.1:5432/primer`; one step `id: docker-test` using `0xPolygon/pipelines/.github/actions/docker-test@main` with `tag: ${{ inputs.tag || '' }}`, `health_path: /api/health` (comment: Primer's liveness path; needs the pipelines `health_path` input — P0), and `test_vars: DATABASE_URL AUTH_MODE OKTA_ISSUER OKTA_CLIENT_ID OKTA_CLIENT_SECRET AUTH_BASE_URL STORAGE_ROOT LOG_LEVEL`; outputs `image_tag`, `dockerfile_path`, `checkout_ref`, `should_build` mapped from the step (`image_name` is not mapped — see next bullet). Comment why `172.17.0.1` (the app container reaches the runner-published port through the Docker bridge gateway; `localhost` inside the container is the container) and why Okta placeholders are safe (discovery is lazy; the smoke suite never triggers login).
  - job `release` with `needs: test`, `if: needs.test.outputs.should_build == 'true'`, `uses: 0xPolygon/pipelines/.github/workflows/apps-docker-release.yml@main`, `with: image_name: primer` **literal**, preceded by a comment: the action derives `api` from the `@primer/api` tag, but the Artifact Registry repository and the dry-dock Kargo warehouse are `…/polygonlabs-docker-prod/primer`; the package is not renamed because open PRs carry `@primer/api` changesets (Ruling 1). The other three `with:` inputs from `needs.test.outputs`, and `secrets: build_params_gh_secret_keys: ${{ secrets.build_params_gh_secret_keys }}` (explicit by name — never `secrets: inherit`).
  - **Files**: .github/workflows/docker-release-trigger.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color .github/workflows/docker-release-trigger.yml && grep -cE '^\s+image_name: primer$' .github/workflows/docker-release-trigger.yml && grep -cE '^\s+health_path: /api/health$' .github/workflows/docker-release-trigger.yml` → actionlint exit 0, then `1`, then `1`
- [ ] **Action**: Prove the trigger's `test_vars` and `job.env` agree and match the local script: every name in `test_vars` is a key under `jobs.test.env`, and `scripts/container-smoke.sh` passes the same names with `-e`.
  - **Files**: .github/workflows/docker-release-trigger.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `for v in $(sed -n 's/.*test_vars: *//p' .github/workflows/docker-release-trigger.yml); do grep -qE "^ {6}$v:" .github/workflows/docker-release-trigger.yml && grep -q -- "-e $v" scripts/container-smoke.sh || { echo "MISSING $v"; exit 1; }; done; echo VARS_OK` → prints `VARS_OK`
- [ ] **Action**: Rewrite the second header paragraph of `release.yml` (the one justifying "does NOT auto-merge the Version Packages PR" by Railway auto-deploying from master). New truth: merging the Version Packages PR is the release — it publishes npm packages, pushes the release tags, and the `@primer/api@X.Y.Z` tag triggers `docker-release-trigger.yml`, which tests and publishes the image Kargo then promotes manually; so the PR stays the deliberate human gate for the service image, the npm packages and the plugin content together. Nothing else in the file changes.
  - **Files**: .github/workflows/release.yml
  - **Owner**: Implementation agent: ci
  - **Verify**: `grep -c -i railway .github/workflows/release.yml` → `0`; `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest .github/workflows/release.yml` → exit 0
- [ ] **Action**: Add a short "Container image and releases" section to `README.md` (why-level, no file listings): releases are cut by merging the Version Packages PR; the `@primer/api` tag builds, tests and publishes the versioned `primer` image through the team's shared pipelines workflows; deployment is dry-dock/Kargo; `scripts/container-smoke.sh` reproduces the release gate locally. Link `apps/api/Dockerfile` and `.github/workflows/docker-release-trigger.yml` by path.
  - **Files**: README.md
  - **Owner**: Implementation agent: ci
  - **Verify**: `grep -n 'container-smoke.sh' README.md` → one match

## Stage S4: Test plan — full verification

Runs everything end to end on the assembled branch. The smoke suite was written
in S2; this stage proves the pieces hold together, exercises the amd64 leg the
shared pipeline will build on its own runner, and re-checks the machine gates
the PR will face. No files change; a failure here is a plan or stage defect
routed back to the team lead.

- [ ] **Action**: In-process suite, typecheck, build and plugin-version drift check — the same gates as `ci.yml` (local Postgres per "Local test infrastructure", guard included).
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `pnpm install --frozen-lockfile && pnpm run codegen-drift-check && pnpm typecheck && pnpm -r run build && pnpm test` → exit 0, 0 failed
- [ ] **Action**: Release-gate simulation (arm64, the architecture production runs) via the local script.
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `scripts/container-smoke.sh host.docker.internal` → exit 0, `Tests  8 passed`
- [ ] **Action**: amd64 build of the same Dockerfile (emulated locally — slow, several minutes; this is the only pre-merge check of the leg the GCP pipeline builds natively).
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `docker buildx build --platform linux/amd64 -f apps/api/Dockerfile -t primer:ci-amd64 . && docker run --rm --platform linux/amd64 primer:ci-amd64 node -e "console.log(process.arch)"` → prints `x64`
- [ ] **Action**: Changeset gate the PR will face, and the ruling-1 invariants (no rename happened; literal image name present).
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `pnpm exec changeset status --since=origin/master && test "$(node -p 'require("./apps/api/package.json").name')" = '@primer/api' && test "$(node -p 'require("./package.json").name')" = 'primer' && grep -qE '^\s+image_name: primer$' .github/workflows/docker-release-trigger.yml && echo GATES_OK` → prints `GATES_OK`
- [ ] **Action**: Workflow lint across the whole `.github/workflows/` tree (the new trigger plus the edited `release.yml`).
  - **Files**: (none)
  - **Owner**: Implementation agent: verification
  - **Verify**: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color` → exit 0

Monitoring verification stage: omitted — research found no monitored signals
(no Grafana dashboards or alerts reference Primer yet; see Research findings).

## Stage S5: Team-lead review, rebase, draft PR

- [ ] **Action**: Rebase `issue-104-team-standard-docker-release` onto fresh `origin/master` (after #109/#110 merge per P4a — if they have not, decide: wait, or keep the S2 fallback and note it in the PR). Re-run the S4 verify commands post-rebase.
  - **Files**: plans/team-standard-docker-release.md
  - **Owner**: Team lead
  - **Verify**: `git -C <worktree> log --oneline origin/master..HEAD` → one commit per completed stage plus the two plan commits, nothing else; `pnpm exec changeset status --since=origin/master` → exit 0
- [ ] **Action**: Review every stage diff against its declared file set; tick the boxes; open the **draft** PR with this plan's Motivation as the body plus the lines `Supersedes #108 · Closes #104 · Part of #103`, the Rulings as the decisions of record, and the Prerequisites (P0–P4) as a "Before the first release" checklist — including that #92 waits for P0 and P1. Relay P2 (semver warehouse) to Taylan for dry-dock#1445. Do not close #108, move labels on #104, or comment on #104 from the agent; those are the humans' calls once this PR is up.
  - **Files**: plans/team-standard-docker-release.md
  - **Owner**: Team lead
  - **Verify (manual)**: `gh -R 0xPolygon/primer pr view <n> --json isDraft,body` shows `isDraft: true` and the body contains "Supersedes #108", "Closes #104" and "Before the first release".

## Risks the reviewer should look hardest at

1. **Two repos, one release.** The first Primer release needs the pipelines
   `health_path` PR merged (P0) *and* the WIF allowlist applied (P1); until
   both, a tag cut by merging #92 either runs a gate whose readiness check proved
   nothing (before P0, see P0) or a release job that fails on OIDC (before P1). Both are recoverable by
   `workflow_dispatch` with the tag, but holding #92 (Ruling 6b) avoids the
   noise.
2. **`--ignore-scripts` + esbuild.** Primer builds with esbuild (not tsc).
   esbuild's platform binary is an optional dependency so the postinstall is
   not load-bearing under pnpm, but S1B's build verify is the proof; if it
   fails, the sanctioned fallback is to drop `--ignore-scripts` (the workspace
   `allowBuilds` already restricts scripts to esbuild) and report the deviation.
3. **`corepack enable` on `node:24-bookworm-slim`.** Node 24 images still ship
   corepack (removed in Node 25); it downloads pnpm 11.8.0 at build time per
   the root `packageManager`. #108 built with exactly this line, so it is
   verified for this image digest; a future base-image bump to Node 25 breaks
   it and must switch to an explicit install.
4. **Bridge-gateway reachability in CI.** The app container reaches the
   `services:` Postgres at `172.17.0.1:5432` (published on the runner host).
   The template does the same for Compose-published ports; GitHub service
   containers publish the same way. The 30 s `/api/health` poll is the
   detector — the migrate step runs first and fails fast if the DB is
   unreachable, and the action dumps the container logs.
5. **Literal `image_name`.** Nothing checks that `primer` in the trigger
   matches the Artifact Registry repository dry-dock watches; a typo publishes
   to a repository Kargo never reads. S4's grep pins the literal; P2 pins the
   other side.
6. **Version coupling via `fixed`.** From the next release `@primer/web` and
   `@primer/api` share a version. Intended (one artifact), but it is a visible
   change in `CHANGELOG.md` files and GitHub Releases.
7. **Migrations at pod start** (kept from #108): a second replica or a Kargo
   promotion during a long migration would run `migrate` concurrently; drizzle
   takes a lock, but the long-term shape is a Job (Ruling 7).
8. **Local 5432 guard.** The planning machine already had a 5432 listener; an
   executor on the same machine will be blocked at the first Compose step
   until the operator frees the port — by design (Ruling 5), not a plan bug.

## Execution prerequisites

- **Branch verification (mandatory).** `git -C /Users/dcollins/apps-team-workspace/repositories/primer/.claude/worktrees/team-standard-deploy fetch origin`; confirm `git -C <that path> branch --show-current` is `issue-104-team-standard-docker-release`; `git -C <that path> log --oneline origin/master..HEAD` must show the two plan commits (genesis + rulings). Use `git -C <absolute-path>` for every git command — never rely on CWD; the workspace guard requires the literal path immediately before `commit`.
- **Base branch is `master`** for Primer and `main` for pipelines — every generic `origin/main` in the skill text reads `origin/master` for Primer commands (`changeset status --since=origin/master`, `git log origin/master..HEAD`).
- **Execution branch**: `issue-104-team-standard-docker-release` in the worktree above, branched off `origin/master`. Push it before each wave so `origin/issue-104-team-standard-docker-release` is current for worktree-isolated agents.
- **Second repo (S1A only)**: the pipelines worktree from S1A's instructions, branch `feat/docker-test-health-path` off `origin/main`. The session CWD never moves between repos; everything is `git -C <literal path>` and absolute file paths.
- **Worktree isolation** for the one parallel wave (S1A ∥ S1B): S1A already runs in its own repo/worktree; S1B runs in the Primer worktree. If both are dispatched as agents, each gets its own tree by construction — no shared checkout. Each isolated Primer agent's first step is `git checkout --detach origin/issue-104-team-standard-docker-release`, then verify the tip subject matches the expected stage commit; on mismatch report blocked.
- **Install before verify**: fresh worktrees have no `node_modules` — `pnpm install --frozen-lockfile` first, in whichever repo the stage runs. Docker is required on the executing machine (local arm64 is production's architecture).
- **Every stage commit must be repo-green**: `pnpm typecheck && pnpm test` pass at every Primer commit boundary (Primer has no Husky hooks, so this is the lead's discipline, not a hook's); pipelines' Husky hooks run on their own.
- **Local Postgres** per "Local test infrastructure" (guard first, project name `primer-deploy-test`) must be up before S1B, S2 and S4.

## Execution mechanics

Waves, read off the graph: W1 = {S0}; W2 = {S1A, S1B} (parallel: different
repos); W3 = {S2}; W4 = {S3}; W5 = {S4}; W6 = {S5, team lead}. A multi-stage
wave compiles into one ephemeral `Workflow` call with one `agent()` per stage,
`isolation: 'worktree'` where the stage runs in the Primer repo, `model` copied
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
  plan ticks, commits, the rebase in S5, the pipelines commit/push/draft PR in
  S1A, and the Primer draft PR. Never delegates a merge, rebase or push.
- **Implementation agents** (`general-purpose`, never Explore): edit only their
  declared file set; no `git commit/push/merge/rebase`, no release or
  versioning command (`changeset version`, `changeset publish`); the only git
  mutation is the sanctioned setup detach; report via the contract above, with
  `blocked` set rather than editing outside the file set, weakening a check, or
  stopping a container they did not start.
- **Author ≠ judge**: an agent's `pass: true` is necessary, not sufficient; the
  lead's post-merge re-run gates the stage.

## Commit policy

- One commit per completed stage, Conventional Commits, scope `deploy` unless a
  better one fits: `chore(deploy): changesets fixed group for api and web`
  (S0), `feat(docker-test): add health_path input …` (S1A, in pipelines),
  `feat(deploy): Dockerfile, .dockerignore, changeset` (S1B), `test(deploy):
  container smoke suite and local simulation` (S2), `ci(deploy): docker release
  trigger workflow and docs` (S3), `test(deploy): full verification` (S4 ticks
  only; if S4 changes no file, fold its ticks into S5's commit), `docs(plans):
  mark team-standard docker release executed` (S5).
- **Every Primer stage commit body carries `Refs #104`** (Ruling 4), then the
  `Claude-Session:` trailer. The pipelines commit carries neither an issue ref
  nor a session link (public repo, Ruling 2).
- The stage commit ticks that stage's boxes in this file and folds reported
  deviations in; the plan at any commit is the progress record.
- Versioning artifact rides with its stage: the changeset lands in S1B's
  commit. No other Primer stage needs one (S0/S2/S3 are outside any package or
  covered by the same release); the pipelines change needs none (outside
  `packages/*`).
- Proceeding to execution is the commit permission for the per-stage commits,
  anchored to the user's go-ahead. Pushing the Primer branch between waves (for
  worktree-isolated agents) and pushing the pipelines branch for its draft PR
  are part of that permission; opening the Primer PR is not — S5 asks.
- No squashing or reorganising within this skill; `/energize` afterwards is the
  user's option.
