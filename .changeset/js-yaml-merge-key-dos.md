---
"@primer/api": patch
"@primer/web": patch
---

Security: clear the `js-yaml` high advisory GHSA-2883-xcg3-v3hh
(`maxTotalMergeKeys` does not limit CPU use for empty merge sources —
quadratic-complexity CPU DoS via YAML merge keys). Raises the per-major
transitive overrides in `pnpm-workspace.yaml` from `^3.15.1` to `^3.15.2` and
from `^4.3.1` to `^4.3.2`.

The existing `^` ranges already admitted the patched releases, but the lockfile
stayed on 3.15.1 / 4.3.1: both patches were published 2026-08-26 and were still
inside the repo's 14-day `minimumReleaseAge` gate when the lockfile was last
resolved. They have now cleared it, so no gate bypass is needed and
`minimumReleaseAgeExclude` stays empty. The floors are pinned explicitly so a
future re-resolve cannot silently drop back to a vulnerable version.

Exposure was dev-tooling only — the vulnerable paths ran through
`@changesets/cli` on both majors (`read-yaml-file` on 3.x, `@changesets/parse`
on 4.x), never the API or web runtime. The two first-party consumers behind
these overrides, `gray-matter` (api) and `react-diff-viewer-continued` (web),
parse only first-party content.

`qs` `^6.16.0` (2 moderate) remains deferred and is tracked separately; it does
not trip `--audit-level=high`.
