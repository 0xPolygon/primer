# Changesets

This repo versions and publishes its packages with
[changesets](https://github.com/changesets/changesets). Every PR that changes
a workspace package needs a changeset (`pnpm exec changeset add`, or
`--empty` for non-shippable changes inside a package).

`bumpVersionsWithWorkspaceProtocolOnly` is `false`, matching the team template
(`apps-team-ts-template/.changeset/config.json`). Sibling dependencies stay
`workspace:^` in source: `changeset version` skips `workspace:` ranges either
way, and pnpm rewrites them to real semver only when it packs each package at
publish time. So in-repo installs keep resolving workspace packages locally,
which matters here because the container image is built from the workspace at
the release tag (`apps/api/Dockerfile`, frozen lockfile) and bundles
`primer-api-types` from source, and the 14-day `minimumReleaseAge` gate in
`pnpm-workspace.yaml` would block a freshly published api-types if an install
resolved it from npm. `false` is what keeps semver `peerDependencies` ranges on
siblings bumped, which a `workspace:` range cannot always express.

`@primer/api` and `@primer/web` are a `fixed` group so they always version
together: the SPA ships only inside the API image, so a web-only changeset
would tag a version with no Dockerfile to build and the fix would never deploy.
