# Extract `@polygonlabs/primer-client`: the REST client as its own published package

## Motivation / Executive Summary

`@polygonlabs/primer-mcp` currently plays two roles at once: it is the MCP tool surface agents call interactively, and it privately contains the only implementation of Primer's programmatic access layer — the typed REST client (`PrimerClient`), the token store, and the device-login machinery. Field reality (reported by the repo owner) is that most consumers have converged on calling the REST API directly, using the MCP chiefly for authentication. The package boundaries should match that reality: the mature-MCP-server pattern — GitHub MCP over `go-github`, Stripe's agent toolkit over the Stripe SDK — is a thin adapter over a reusable client, not a client trapped inside an adapter.

The cost of the current shape is shadow clients. Because the client layer is unreachable (the mcp package publishes a `bin` and no importable surface), programmatic consumers hand-copy the wire protocol — the fleet-command PADD publish script re-implemented token resolution, URL normalization, endpoint paths, and multipart field names, and had already drifted (inventing `PRIMER_TOKEN`/`PRIMER_URL` where the real surface is `PRIMER_API_TOKEN`/`PRIMER_API_URL`, so documented configuration was silently ignored). An earlier attempt to fix this with subpath exports from the bin package (#79) was closed: it forced either a declaration bundler or type duplication. #81 solved the types half by publishing the wire contract (`@polygonlabs/primer-api-types`); this migration completes the layering with the client half.

This extraction creates **`packages/client`**, published as **`@polygonlabs/primer-client`**: `PrimerClient` + `PrimerApiError`, the token store, and the device-login functions, depending only on `@polygonlabs/primer-api-types`. The boundary is deliberate: the token store's read path (`resolveToken`) is what scripts need to reuse a token a human already approved, and read/write share one file-format implementation, so the whole store moves; `deviceLogin.ts` is REST calls to the `/auth/device` endpoints (and already imports `PrimerApiError` from the client module), so it moves too. What stays in `@polygonlabs/primer-mcp` is exactly its adapter role: the MCP tool registrations, the comment formatter, and the interactive auth orchestration (`primer_login` returning a code for a human to type, long-polling, the never-show-the-agent-the-token policy).

One latent defect is fixed in flight: `tokenStore.ts`'s public signatures use `NodeJS.ProcessEnv`, which would make the published package's declarations depend on ambient `@types/node` — the exact leak the #79 scratch-consumer verification caught. The signatures adopt a structural `EnvLike` type (`Record<string, string | undefined>`; `process.env` is assignable) so a `--strict --moduleResolution nodenext` consumer typechecks with no `@types/node` installed.

The final stack is three packages with honest dependency direction, each named for what it contains: `primer-api-types` (the contract) ← `primer-client` (the programmatic surface) ← `primer-mcp` (the agent adapter). The mcp bin continues to bundle its workspace dependencies (guards, types, and now the client inline into `dist/index.js`), exactly as it bundled `@primer/shared` before #81, so nothing changes for existing mcp installs.

## Benefits

- **Kills shadow clients**: `npm install @polygonlabs/primer-client` gives scripts, watchers, and CI the exact client + token store the MCP server runs on — auth reuses the token the user already approved via `primer_login`; no copied wire protocol left to drift.
- **Package boundaries match usage**: consumers who call the API directly (the majority, per the repo owner) get a dependency that contains only that; the MCP package shrinks to its adapter role (3 modules: `index.ts`, `tools.ts`, `format.ts`).
- **Completes the #79 arc properly**: no subpath-export contortions in a bin package, no declaration bundler, no type duplication — the client's response types resolve from `@polygonlabs/primer-api-types` by name.
- **Publishable declarations verified hermetic**: the `EnvLike` fix removes the last ambient-types dependency from a public surface; the plan gates on a scratch-consumer typecheck with no `@types/node`.
- **Tests travel with their modules**: the existing `client/tokenStore/deviceLogin` suites (68 of mcp's 114 tests: client 20, tokenStore 23, deviceLogin 25) move into the client package unchanged — coverage is preserved, and each package's suite tests its own code.
- **Zero new runtime dependencies**: the client package depends only on the contract package (type-only at runtime); fetch is native, storage is node builtins.

## Implementation Graph

```mermaid
flowchart TD
    S0[Stage S0: Create packages/client] --> S1[Stage S1: Thin apps/mcp to the adapter role]
    S1 --> S2[Stage S2: Full verify + scratch-consumer check]
    S2 --> S3[Stage S3: Team-lead final review]
```

```json make-it-so-stage-index
{
  "version": 2,
  "stages": [
    {
      "id": "S0",
      "name": "Create packages/client",
      "dependsOn": [],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": ["packages/client/", "apps/mcp/package.json", "pnpm-lock.yaml"],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S1",
      "name": "Thin apps/mcp to the adapter role",
      "dependsOn": ["S0"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": ["apps/mcp/src/", "apps/mcp/scripts/build.mjs", "apps/mcp/README.md"],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S2",
      "name": "Full verify + scratch-consumer check",
      "dependsOn": ["S1"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": [],
      "owner": "implementation-agent",
      "costExpectation": "minutes",
      "model": "sonnet"
    },
    {
      "id": "S3",
      "name": "Team-lead final review",
      "dependsOn": ["S2"],
      "parallelism": "SEQUENTIAL",
      "dispatch": "wave",
      "files": ["plans/extract-primer-client.md"],
      "owner": "team-lead",
      "costExpectation": "minutes",
      "model": "opus"
    }
  ]
}
```

The team-lead stage is pinned `opus` deliberately: the prior run of this shape (#81) showed the lead's cost dominated (77%) on verification-heavy work that needs discipline, not frontier reasoning.

## Stage report contract

Implementation agents report completion in exactly this shape (requested as structured output on every dispatch):

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

An agent that cannot make a verify condition pass within its declared file set reports `blocked` rather than editing outside its file set or weakening a test. The team lead cross-checks `filesChanged` against declared files and re-runs every verify command post-merge.

## Stage S0: Create packages/client

Creates `packages/client` (published name `@polygonlabs/primer-client`) by **moving code, not rewriting it** — the modules come from `apps/mcp/src` verbatim except for the two deliberate changes below. The originals stay in place until Stage S1, so this stage is green independently. The pnpm workspace glob (`packages/*`) picks the directory up automatically.

**Modules moved in (with their tests):**
- `apps/mcp/src/client.ts` → `packages/client/src/client.ts` (+ `client.test.ts`)
- `apps/mcp/src/tokenStore.ts` → `packages/client/src/tokenStore.ts` (+ `tokenStore.test.ts`)
- `apps/mcp/src/deviceLogin.ts` → `packages/client/src/deviceLogin.ts` (+ `deviceLogin.test.ts`)

Internal relative imports (`deviceLogin.ts` → `./client.ts`) survive unchanged (same directory). `client.ts`'s and `deviceLogin.ts`'s imports from `@polygonlabs/primer-api-types` survive unchanged (it becomes this package's one dependency).

**Deliberate change 1 — `EnvLike`:** in the moved `tokenStore.ts`, replace `NodeJS.ProcessEnv` in the two public signatures (`defaultStorePath(env)`, `resolveToken(opts.env)`) with an exported structural type:

```ts
/** Structural stand-in for NodeJS.ProcessEnv so the published declarations
 *  don't depend on the ambient @types/node namespace. `process.env` is
 *  assignable to it. */
export type EnvLike = Record<string, string | undefined>;
```

**Deliberate change 2 — a curated public entry:** `packages/client/src/index.ts` with **explicit named re-exports** (never `export *` — this package is one context, but the public surface should be deliberate):
- from `./client.ts`: `PrimerClient`, `PrimerApiError`, and the types `PrimerErrorCode`, `PrimerClientOptions`, `DocumentFormat`, `CreateDocumentInput`, `AddVersionInput`
- from `./tokenStore.ts`: `saveToken`, `loadToken`, `clearToken`, `resolveToken`, `normalizeBaseUrl`, `defaultStorePath`, and the types `TokenStoreEntry`, `TokenStoreFile`, `EnvLike`
- from `./deviceLogin.ts`: `startDeviceLogin`, `pollOnce`, `pollUntil`, and the types `PollState`, `StartLoginOpts`, `PollOpts`, `PollUntilOpts`

**Packaging** (clone the `packages/api-types` pattern — it is the in-repo exemplar for exactly this shape):
- `package.json`: name `@polygonlabs/primer-client`, version `0.1.0`, `"dependencies": { "@polygonlabs/primer-api-types": "workspace:^" }`, dev-time `types`/`exports` `.` → `./src/index.ts` (raw TS, as every workspace package here), `publishConfig` overriding to `dist/`, `files: ["dist", "README.md", "LICENSE"]`, `engines: { "node": ">=20" }`, `repository.directory: "packages/client"`, MIT. devDependencies: `typescript`, `vitest`, `@types/node` (tests/build only).
- `tsconfig.json` (typecheck) + `tsconfig.build.json` (emit JS + declarations to `dist`, `rootDir: src` — same as api-types; exclude `src/**/*.test.ts` from the build emit).
- `vitest.config.ts` cloned from `apps/mcp/vitest.config.ts` (node environment, `src/**/*.test.ts`).
- `README.md`: the programmatic-use story — install, `resolveToken` + `PrimerClient` example, token-store behavior (store path, `PRIMER_API_TOKEN`/`PRIMER_API_URL`/`PRIMER_TOKEN_FILE` precedence, atomic 0600 writes), note that interactive login lives in `@polygonlabs/primer-mcp`. `LICENSE`: copy of `apps/mcp/LICENSE`.

- [ ] **Action**: Create the `packages/client` scaffolding (package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, README.md, LICENSE) per the packaging spec above.
  - **Files**: packages/client/package.json, packages/client/tsconfig.json, packages/client/tsconfig.build.json, packages/client/vitest.config.ts, packages/client/README.md, packages/client/LICENSE
  - **Owner**: Implementation agent: client-package
  - **Verify**: `node -e "const p=require('/dev/stdin');" < /dev/null; node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('packages/client/package.json'));if(p.private)throw new Error('private');if(p.publishConfig?.access!=='public')throw new Error('publishConfig');if(!p.dependencies?.['@polygonlabs/primer-api-types'])throw new Error('missing contract dep');console.log('ok')"` → prints `ok`
- [ ] **Action**: Move `client.ts`, `tokenStore.ts`, `deviceLogin.ts` and their three test files into `packages/client/src/` (copy verbatim; leave the `apps/mcp/src` originals untouched), apply the `EnvLike` change to the moved `tokenStore.ts`, and create the curated `src/index.ts` entry.
  - **Files**: packages/client/src/index.ts, packages/client/src/client.ts, packages/client/src/client.test.ts, packages/client/src/tokenStore.ts, packages/client/src/tokenStore.test.ts, packages/client/src/deviceLogin.ts, packages/client/src/deviceLogin.test.ts
  - **Owner**: Implementation agent: client-package
  - **Verify**: `pnpm --filter @polygonlabs/primer-client run typecheck && pnpm --filter @polygonlabs/primer-client run test && pnpm --filter @polygonlabs/primer-client run build && ! grep -rn "NodeJS\." packages/client/dist/*.d.ts` → typecheck green, moved suites pass in their new home, build emits dist, no ambient-namespace reference in shipped declarations
- [ ] **Action**: Add `"@polygonlabs/primer-client": "workspace:^"` to `apps/mcp/package.json` `devDependencies` (bundled into the bin, exactly like `@polygonlabs/primer-api-types`) and run `pnpm install` to update the lockfile. Do NOT touch `apps/mcp/src` (that is Stage S1).
  - **Files**: apps/mcp/package.json, pnpm-lock.yaml
  - **Owner**: Implementation agent: client-package
  - **Verify**: `pnpm install && pnpm typecheck` → install succeeds, repo-wide typecheck green (originals and copies coexist; nothing imports the new package yet)

## Stage S1: Thin apps/mcp to the adapter role

Deletes the moved modules from `apps/mcp/src` and repoints the adapter files at the published client. After this stage `apps/mcp/src` contains exactly the adapter: `index.ts`, `tools.ts`, `tools.test.ts`, `format.ts`, `format.test.ts`.

Repoint map (measured):
- `src/index.ts:28-30`: three relative imports (`./client.ts`, `./deviceLogin.ts`, `./tokenStore.ts`) → one or more imports from `@polygonlabs/primer-client`.
- `src/tools.ts:6-7`: `PrimerApiError`, `type PrimerClient`, `type PrimerErrorCode`, `pollUntil`, `startDeviceLogin` → `@polygonlabs/primer-client`.
- `src/tools.test.ts`: its imports of `PrimerApiError` / `type PrimerClient` from `./client.ts` → `@polygonlabs/primer-client`.
- Delete `src/client.ts`, `src/client.test.ts`, `src/tokenStore.ts`, `src/tokenStore.test.ts`, `src/deviceLogin.ts`, `src/deviceLogin.test.ts`.
- `scripts/build.mjs`: no functional change (devDependencies are already bundled — the externals list is built from `dependencies` only); update the strategy comment to name `@polygonlabs/primer-client` alongside `@polygonlabs/primer-api-types` as bundled workspace packages.
- `README.md`: the "Token store" and env-var reference sections now describe behavior owned by the client package — replace with a short summary + pointer to `packages/client/README.md`; keep the device-login UX documentation (that is the mcp's adapter role); add a short "Programmatic use" pointer: deterministic automation should depend on `@polygonlabs/primer-client` directly rather than driving the MCP.

- [ ] **Action**: Repoint `index.ts`, `tools.ts`, `tools.test.ts` to `@polygonlabs/primer-client` and delete the six moved source/test files from `apps/mcp/src`.
  - **Files**: apps/mcp/src/index.ts, apps/mcp/src/tools.ts, apps/mcp/src/tools.test.ts, apps/mcp/src/client.ts (D), apps/mcp/src/client.test.ts (D), apps/mcp/src/tokenStore.ts (D), apps/mcp/src/tokenStore.test.ts (D), apps/mcp/src/deviceLogin.ts (D), apps/mcp/src/deviceLogin.test.ts (D)
  - **Owner**: Implementation agent: mcp-thin
  - **Verify**: `! grep -rn "\./client.ts\|\./tokenStore.ts\|\./deviceLogin.ts" apps/mcp/src && test ! -f apps/mcp/src/client.ts` → no relative references to the moved modules remain; files are gone
- [ ] **Action**: Update the `scripts/build.mjs` strategy comment and rework the README sections per the map above.
  - **Files**: apps/mcp/scripts/build.mjs, apps/mcp/README.md
  - **Owner**: Implementation agent: mcp-thin
  - **Verify**: `grep -n "primer-client" apps/mcp/scripts/build.mjs apps/mcp/README.md` → both reference the client package
- [ ] **Action**: Confirm the thinned adapter is independently green and the published bundle self-contains the client.
  - **Files**: (none — verification only)
  - **Owner**: Implementation agent: mcp-thin
  - **Verify**: `pnpm --filter @polygonlabs/primer-mcp run typecheck && pnpm --filter @polygonlabs/primer-mcp run test && pnpm --filter @polygonlabs/primer-mcp run build && ! grep -n "@polygonlabs/primer-client\|@polygonlabs/primer-api-types" apps/mcp/dist/index.js` → typecheck/tests/build green; no unresolved workspace-package references in the bundle (all inlined)

## Stage S2: Full verify + scratch-consumer check

The test-plan stage. No new behavior exists (the moved suites cover the moved code), so no new tests are written; the two gates are the CI-equivalent chain and a hermetic consumer verification of the published artifacts — the check that caught the `NodeJS.ProcessEnv` leak the first time.

Environment: requires the Docker daemon for the api suite's Postgres (`pnpm db:up`, `pnpm db:migrate:test` with `DATABASE_URL_TEST=postgres://primer:primer@localhost:5432/primer_test`). If the daemon is unavailable, this stage is **blocked** — never skipped or partially verified.

- [ ] **Action**: Run the full CI-equivalent verification.
  - **Files**: (none — verification only)
  - **Owner**: Implementation agent: verify
  - **Verify**: `pnpm db:up && pnpm db:migrate:test && pnpm typecheck && pnpm -r run build && pnpm test` → every step passes (api ~669; web ~223; mcp shrinks to the 46 adapter tests — format 5, tools 41; the client package gains the 68 moved tests — mcp+client total stays 114)
- [ ] **Action**: Scratch-consumer verification of the published artifacts: `pnpm pack` both `packages/api-types` and `packages/client` (pnpm rewrites the `workspace:^` dependency to a real semver range — verify the packed `package.json` shows `^0.1.0`, not `workspace:^`); in a scratch npm project, install the types tarball then the client tarball plus `typescript@6` (NO `@types/node`); typecheck a `--strict --module nodenext --moduleResolution nodenext` consumer that imports `PrimerClient`, `PrimerApiError`, `resolveToken`, `normalizeBaseUrl` and type-asserts `getVersionThreads`/`createDocument`/`getDocument` return types; then run it under node to prove runtime imports resolve (network calls will fail against a dead host — that error is `PrimerApiError` with `code: 'network'`, which is the *pass* condition for the runtime probe).
  - **Files**: (none — scratch dir outside the repo)
  - **Owner**: Implementation agent: verify
  - **Verify (manual)**: The scratch consumer typechecks with no `@types/node` installed, runtime imports execute, and the packed client `package.json` carries a semver (not `workspace:`) dependency on `@polygonlabs/primer-api-types`. Record the exact commands and output in the stage report.

## Monitoring verification stage — omitted

No monitored signals are touched: `PrimerApiError` is a client-side error class in an npm package — no dashboard, monitor, or server log pipeline keys on it, and no server code changes in this migration. Per the empty-category rule, no monitoring stage exists in this plan.

## Stage S3: Team-lead final review

- [ ] **Action**: Cross-check every stage's committed diff against its declared file set; confirm all checkboxes in this plan are ticked in the committed plan; re-run the S2 CI-equivalent chain once on the assembled branch; write the completion report (stages, commit SHAs, verify results, diff summary, deviations, tooling problems).
  - **Files**: plans/extract-primer-client.md
  - **Owner**: Team lead
  - **Verify**: `pnpm typecheck && pnpm -r run build && pnpm test` → green on the final assembled branch
- [ ] **Action**: Confirm every stage commit is pushed to `origin/refactor/extract-primer-client`, and do NOT open a pull request. Report the end state; the PR decision returns to the user (the eventual PR targets `master` — see Risks).
  - **Files**: (none)
  - **Owner**: Team lead
  - **Verify (manual)**: `git log origin/refactor/extract-primer-client..HEAD` is empty (everything delivered) and no PR exists for the branch.

## Execution prerequisites

- **Base branch is `origin/master`.** PR #81 (the `@primer/shared` dissolution) was squash-merged as `9853765` and PR #76 (mcp disk round-tripping) merged as `6b808cf`, so master already contains `packages/api-types`, the post-dissolution `apps/mcp`, and the `getVersionContent`/`toDisk`/`contentPath` features. The working tree is `/Users/dcollins/apps-team-workspace/repositories/primer/.claude/worktrees/extract-client`, branch `refactor/extract-primer-client`, rebased onto `origin/master`. Before the first stage commit: `git -C <worktree> fetch origin`, confirm `git -C <worktree> branch --show-current` = `refactor/extract-primer-client`, and confirm `git -C <worktree> log --oneline origin/master..HEAD` shows only this plan's commit(s). Use `git -C <absolute-path>` for every git command — never rely on CWD.
- **All stages are sequential** — no parallel wave exists in this plan, so no worktree isolation is required; if stages are delegated to implementation agents, they run one at a time in this single working tree (never two file-editing agents concurrently).
- **Repo-green commits**: no git hooks exist in this repo (verified in the #81 run), but every stage commit must leave `pnpm typecheck` green — the stage boundaries above are drawn so this holds.
- **No versioning artifacts**: primer does not use changesets. `@polygonlabs/primer-client` starts at `0.1.0`; npm publish (order: api-types → client → mcp) is a post-merge maintainer step outside this plan.

## Execution mechanics

Waves read off the graph are all single-stage: dispatch each as a plain Agent call (a one-agent workflow buys nothing), model pinned verbatim from the Stage Index, structured report per the contract above — or, if the executing session prefers, implement S0–S2 directly and self-verify; with no parallelism the delegation is optional. Either way the binding gate is the same: the team lead (the executing session) re-runs every verify command itself before committing a stage — author≠judge. Briefs, if dispatching: mount this plan by path and stage heading (plan blob hash + stage id + base tree hash + verbatim verify commands), never paraphrase it.

After each stage: re-run the stage's verify commands, tick the stage's checkboxes in this document, fold reported deviations into the plan text, and commit — plan update in the same commit. A `blocked` report stops the line for adjudication; never patch around it.

## Team structure

- **Team lead**: the executing session. Owns diff review, all git operations, checkbox updates, per-stage commits, failure adjudication, and the final report.
- **Implementation agents** (if used): full-capability `general-purpose` agents, one per stage, models per the Stage Index. File changes only — no `git commit`/`push`/`merge`, no versioning commands; completion via the stage report contract.

## Commit policy

- One commit per completed stage, by the team lead, only after every checklist item verifies green — intentional and autonomous; do not pause to re-ask between stages. Proceeding to execution is the commit permission for this run.
- The stage commit ticks this plan's checkboxes and folds in deviations, in the same commit as the code — the plan's checkbox state at any commit is the resume record.
- Messages follow Conventional Commits: `feat(client): Stage S0 — create packages/client`, `refactor(mcp): Stage S1 — thin apps/mcp to the adapter role`, `test: Stage S2 — full verify + scratch-consumer check`.
- Do not reorganize or squash during execution (energize runs afterward as a separate, user-invoked step). Push each stage commit to `origin/refactor/extract-primer-client` as it lands (plain push, never force) — the branch is the delivery channel to the user. NEVER open a PR — Stage S3 hands that decision back.

## Risks & sequencing (informative)

- **Base facts (both prior PRs merged)**: #81 squash-merged (`9853765`), #76 merged (`6b808cf`). The moved `client.ts` therefore already includes #76's `getVersionContent()` and the shared `send()` split, and `tools.ts` carries `toDisk`/`contentPath` — none of that changes the extraction shape (modules move whole), it just rides along. The eventual PR targets `master` directly; no stacking.
- **Remote branch hygiene**: `refactor/dissolve-shared` still exists on origin post-squash-merge (auto-delete not enabled) — a cleanup candidate for the user, outside this plan's scope.
- **Publish ordering** (post-merge, maintainer): `@polygonlabs/primer-api-types` → `@polygonlabs/primer-client` → `@polygonlabs/primer-mcp`. `pnpm publish` (not `npm publish`) so `workspace:^` ranges rewrite.
- **Planner-research note**: Phase 1 research for this plan was performed directly by the planner rather than via the parallel research fanout — the entire change surface is one package the planner had just inventoried twice (in the #81 planning research and its energize diff-read); the module graph facts above (import sites, export lists, test file inventory, build-script externals logic) were verified against the live branch at planning time.
