# Changesets

This repo versions and publishes its packages with
[changesets](https://github.com/changesets/changesets). Every PR that changes
a workspace package needs a changeset (`pnpm exec changeset add`, or
`--empty` for non-shippable changes inside a package).

One deliberate deviation from the team template
(`apps-team-ts-template/.changeset/config.json`):
`bumpVersionsWithWorkspaceProtocolOnly` is `true` here, not `false`. The
template rewrites `workspace:^` to real semver at Version Packages time so
Docker builds at release tags can install the npm-published versions. Primer
has no such build — the Railway app installs from the repo — and its private
apps (`@primer/api`, `@primer/web`) have runtime `workspace:^` deps on
`@polygonlabs/primer-api-types`. Rewriting those to semver would make in-repo
installs resolve api-types from npm, where the 14-day `minimumReleaseAge`
gate in `pnpm-workspace.yaml` blocks freshly published versions. Keeping the
workspace protocol keeps every in-repo install local; `pnpm publish` still
converts `workspace:` ranges to real semver in published tarballs, and no
published package carries a workspace range in runtime `dependencies` anyway.
