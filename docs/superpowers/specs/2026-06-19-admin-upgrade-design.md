# Primer admin upgrade — design

Date: 2026-06-19

## Goal

Upgrade the Primer admin view from six top-line stat cards to a single-page
dashboard with three sections — Adoption, Engagement, Operational — backed by
roughly four weeks of accumulated production data. Charts are hand-rolled
inline SVG; no chart library is added. The endpoint stays at
`GET /api/admin/stats` and stays open to any logged-in user (no role gating).

The full window is the last 30 days, daily granularity, UTC. The control set
is fixed for now (no user-selectable range).

## Non-goals

Explicit out-of-scope list:

- User-selectable date range (week / month / 90 days / all-time)
- CSV / JSON export
- Per-user or per-document drilldown
- Tooltips, hover interactions, click-through
- Real-time / push refresh; React Query polling is enough
- Role-gated access; auth middleware is enough
- Precomputed rollup tables, materialized views, cron jobs
- Period-over-period deltas, anomaly callouts, percentile lines
- Mobile layouts beyond the existing `DesktopOnly` gate

## Architecture

### File layout

API:

- `apps/api/src/routes/admin.ts` — expanded handler, still one route
  `GET /api/admin/stats`. Calls each block builder in parallel and assembles
  the response.
- `apps/api/src/services/adminStats.ts` *(new)* — pure functions
  `buildTotals`, `buildAdoption`, `buildEngagement`, `buildOperational`. Each
  returns a typed block. Keeps the route thin and makes each block directly
  testable.
- `apps/api/src/services/adminStats.test.ts` *(new)* — fixture-driven unit
  tests, one suite per block.
- `apps/api/src/routes/admin.test.ts` — extended to seed multi-day data and
  assert shape / ordering / zero-fill / pre-window seeding end-to-end.

Web:

- `apps/web/src/routes/admin.tsx` — orchestrator. Three `<section>` blocks
  under the existing stat-card grid. Loading / error states centralised here.
- `apps/web/src/components/admin/` *(new directory)*:
  - `StatCard.tsx` — moved from `admin.tsx`.
  - `AreaChart.tsx` — stacked area (A1 createdPerDay).
  - `LineChart.tsx` — single line (A2 activeUsers, A3 cumulativeUsers,
    O1 storageBytesPerDay).
  - `BarList.tsx` — horizontal bar list with label + count (E1 top documents,
    E2 top commenters).
  - `Histogram.tsx` — vertical histogram with bucket labels (E3 views per
    document).
  - `StackedBar.tsx` — grouped/stacked vertical bars per day (O2 threads
    opened vs resolved).
  - `Sparkline.tsx` — tiny line for the inline aging-threads card (O3).
  - `chartGeom.ts` — pure helpers (`linearScale`, `niceTicks`,
    `formatTickDate`, `clamp`). No React imports; directly unit-testable.
  - `chartGeom.test.ts` *(new)* — covers `chartGeom.ts`.
- `apps/web/src/queries/admin.ts` — type only; payload changes but the hook
  shape stays the same.

Shared:

- `packages/shared/src/api.ts` — expand `AdminStatsResponse` (see
  [API contract](#api-contract)).

### Request shape

One request, one loading state, all-or-nothing error handling.
`GET /api/admin/stats` returns the entire payload. React Query caches it with
`staleTime: 60_000` (up from today's 30 s). No new endpoints, no query
params.

## API contract

The existing six `AdminStatsBucket` fields stay verbatim so older
clients / tests don't break. Three new top-level blocks are added.

```ts
interface AdminStatsBucket {
  total: number;
  last7d: number;
}

interface DailyPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  value: number;
}

interface DailyStackPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  documents: number;
  versions: number;
  comments: number;
}

interface ThreadFlowPoint {
  date: string;
  opened: number;
  resolved: number;
}

interface TopDocument {
  documentId: string;
  title: string;
  views: number;
}

interface TopCommenter {
  userId: string;
  displayName: string;
  comments: number;
}

interface HistogramBucket {
  bucket: string;   // '0', '1-2', '3-5', '6-10', '11-25', '26+'
  count: number;
}

interface AdminStatsResponse {
  // unchanged
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;

  // new
  rangeDays: 30;
  adoption: {
    createdPerDay: DailyStackPoint[];      // exactly 30 entries, oldest→newest
    activeUsersPerDay: DailyPoint[];       // exactly 30 entries
    cumulativeUsers: DailyPoint[];         // exactly 30 entries, monotonic non-decreasing
  };
  engagement: {
    topDocumentsByViews: TopDocument[];    // up to 10, all-time, alive docs only
    topCommenters: TopCommenter[];         // up to 10, last 30d, alive comments only
    viewsPerDocHistogram: HistogramBucket[]; // exactly 6 buckets, in defined order
  };
  operational: {
    storageBytesPerDay: DailyPoint[];      // exactly 30 entries, cumulative
    threadsOpenedVsResolved: ThreadFlowPoint[]; // exactly 30 entries
    openThreadsAgingOver14d: {
      count: number;                       // current count
      sparkline: DailyPoint[];             // exactly 30 entries
    };
  };
}
```

Invariants:

- All daily series have exactly `rangeDays` entries.
- All series are sorted oldest→newest.
- All dates are UTC `YYYY-MM-DD` strings, never `Date` objects, never ISO
  timestamps.
- Histogram buckets are returned in canonical order even when empty.

## Query strategy

All queries are computed on the fly, in parallel via `Promise.all` from the
route handler. Daily series use Postgres `generate_series` left-joined
against per-day aggregates so the result is always 30 zero-filled rows.

### Block builders (`services/adminStats.ts`)

`buildTotals()` — unchanged from today; 12 `count(*)` queries (six totals,
six last-7d). Kept for back-compat.

`buildAdoption()`:

- **A1 `createdPerDay`** — three `SELECT date_trunc('day', created_at)::date
  AS d, count(*)` queries on `documents` (alive), `versions`, `comments`
  (alive), each `WHERE created_at >= now()::date - 29`. Combined in JS into
  the stacked shape after left-joining against the 30-day series spine.
- **A2 `activeUsersPerDay`** — one query: `UNION ALL` of `(uploader_id,
  created_at::date)` from `documents` (alive), `(uploader_id,
  created_at::date)` from `versions`, `(author_id, created_at::date)` from
  `comments` (alive), `(user_id, viewed_at::date)` from `documentViews`,
  filtered to the 30-day window; outer query groups by day with
  `count(distinct user_id)`.
- **A3 `cumulativeUsers`** — one query for new users per day in the window,
  one `preWindowTotal()` helper query for the count of users created strictly
  before the window. Cumulative sum computed in JS and seeded with the pre-
  window total.

`buildEngagement()`:

- **E1 `topDocumentsByViews`** — `SELECT document_id, count(*) FROM
  document_views v JOIN documents d ON d.id = v.document_id WHERE d.deleted_at
  IS NULL GROUP BY document_id, d.title ORDER BY count DESC LIMIT 10`. All-
  time, not windowed.
- **E2 `topCommenters`** — `SELECT author_id, count(*) FROM comments c JOIN
  users u ON u.id = c.author_id WHERE c.deleted_at IS NULL AND c.created_at
  >= now() - interval '30 days' GROUP BY author_id, u.display_name ORDER BY
  count DESC LIMIT 10`.
- **E3 `viewsPerDocHistogram`** — subquery `SELECT document_id, count(*) AS
  v FROM document_views JOIN documents ON … WHERE deleted_at IS NULL GROUP
  BY document_id`, returns one row per alive document. Bucketed in JS into
  the predefined edges `[0, 1–2, 3–5, 6–10, 11–25, 26+]`. Documents with
  zero views are included by left-joining `documents` against the subquery.

`buildOperational()`:

- **O1 `storageBytesPerDay`** — one query for `sum(size_bytes)` per day in
  the window from `versions`, one `preWindowTotal()` helper for the sum
  strictly before the window. Cumulative sum in JS, seeded.
- **O2 `threadsOpenedVsResolved`** — two grouped counts, one over
  `threads.created_at`, one over `threads.resolved_at`, both 30-day windowed.
  Merged in JS into the per-day `{opened, resolved}` shape.
- **O3 `openThreadsAgingOver14d.count`** — `SELECT count(*) FROM threads
  WHERE resolved_at IS NULL AND created_at < now() - interval '14 days'`.
- **O3 `openThreadsAgingOver14d.sparkline`** — one query driven by
  `generate_series(now()::date - 29, now()::date, '1 day')` that, for each
  day `d`, counts threads where `created_at < d - interval '14 days' AND
  (resolved_at IS NULL OR resolved_at > d)`. Returns 30 points.

### `preWindowTotal()` helper

A single helper shared by A3 and O1. Signature roughly
`preWindowTotal(table, valueExpr, dateColumn, windowStart): Promise<number>`.
Returns the `sum(valueExpr)` (or `count(*)` if `valueExpr` is `1`) over rows
strictly before `windowStart`. Lives in `services/adminStats.ts`.

### Performance

Today's endpoint runs 12 queries. The new endpoint runs roughly 25 queries
(`buildTotals` 12 + adoption 6 + engagement 3 + operational 6). All hit
indexed timestamp columns
(`created_at`, `viewed_at`, `resolved_at`), all are either bounded to a 30-
day window or to a `LIMIT 10`. Expected total under 100 ms at current data
volume; comfortably under 500 ms even at 100× scale. No new indexes
required.

`React Query` `staleTime: 60_000`. The page is single-request, so the
network tab shows one call per minute of active use.

## Frontend

### Page layout

`apps/web/src/routes/admin.tsx`:

- Wrapped in the existing `<DesktopOnly>` gate (unchanged).
- Max-width container raised from `max-w-3xl` to roughly `max-w-[1100px]`
  so the two-column chart grids fit comfortably.
- Three sections under the existing 6-card top-line summary, each with an
  `<h2>` heading and a responsive grid:
  - Adoption — 1 column on `sm`, 2 columns on `md+`. Three charts (A1, A2,
    A3).
  - Engagement — same grid. E1 (top docs) and E2 (top commenters) sit
    side-by-side; E3 (histogram) spans the row beneath them.
  - Operational — same grid. O1 + O2 side-by-side; O3 sits as a small
    "number + sparkline" card.
- Order on the page: summary cards → Adoption → Engagement → Operational.

### Widget components

All components live in `apps/web/src/components/admin/`. Each takes a
`{ data, height? }` prop, renders pure SVG with a `viewBox`, and uses
Tailwind class names on `<text>` / `<path>` for dark-mode-aware colors via
existing project color tokens. No tooltips, no hover, no click handlers in
v1. Axis labels render with the same `text-xs` / `text-neutral-500`
patterns already used by `StatCard`.

`chartGeom.ts` exports pure helpers:

```ts
linearScale(domain: [number, number], range: [number, number]): (x: number) => number
niceTicks(min: number, max: number, count: number): number[]
formatTickDate(yyyymmdd: string): string         // 'Jun 19'
formatBytes(n: number): string                   // '1.2 MB'
clamp(n: number, min: number, max: number): number
```

These are the only items with their own test file
(`chartGeom.test.ts`). The widget components themselves are thin
SVG renderers and are not snapshot-tested.

### Loading state

While `useAdminStats` is in `isLoading`, render the page skeleton:

- Six existing skeleton cards (unchanged).
- Three section headers (real text, no skeleton — purely structural).
- Each chart card rendered with a fixed-aspect placeholder
  (`bg-neutral-100 dark:bg-neutral-800`) sized to the final viewBox so
  layout doesn't shift on load.

### Error state

Unchanged from today: top-of-page red banner with the error message and a
Retry button that calls `q.refetch()`. No per-section error rendering — the
endpoint is all-or-nothing.

### Empty-data behaviour

Every widget renders even when its source data is empty:

- Time-series charts (A1, A2, A3, O1, O2, O3 sparkline) render their axes
  and a centered `<text>` "No data yet" inside the chart area.
- `BarList` (E1, E2) shows the heading and a single muted "No activity in
  this window." line.
- `Histogram` (E3) renders all six bucket labels with zero-height bars.
- `O3` count card shows `0` plus a flat sparkline.

No special "we just launched" mode. Once a single data point exists per
day, the charts fill in naturally.

## Date handling

End-to-end UTC `YYYY-MM-DD` strings:

- API casts every timestamp via `(col)::date` or
  `date_trunc('day', col)::date`. Postgres returns dates the driver
  serializes as `YYYY-MM-DD` strings.
- The 30-day spine is computed as `now()::date - 29 .. now()::date` on the
  database side via `generate_series`. The server clock is authoritative;
  if it drifts, the spine drifts with it (acceptable trade-off at current
  scale).
- The web layer treats `DailyPoint.date` as an opaque string for plotting
  and routes it through `formatTickDate` (`Jun 19`) for labels. No
  `Date` construction, no `Intl.DateTimeFormat` timezone shenanigans.

## Testing

API:

- `apps/api/src/services/adminStats.test.ts` *(new)*: per-block fixture
  tests. Seed a controlled set of users / documents / versions / comments /
  threads / document views spread across 35 days (5 days before window + 30
  in-window). Assert:
  - All daily arrays are length 30.
  - Zero-fill correctly for days with no activity.
  - Cumulative series start at the pre-window total, not zero.
  - Top-N lists respect deleted-at filters and the right window.
  - Histogram bucket order is canonical even when some buckets are empty.
  - O3 sparkline correctly classifies threads as "aging" based on
    `created_at` relative to each historical day, not the present.
- `apps/api/src/routes/admin.test.ts` — extended end-to-end coverage on the
  HTTP shape: payload contains all the new blocks, `rangeDays === 30`,
  every daily array has length 30, error path still works.

Web:

- `apps/web/src/components/admin/chartGeom.test.ts` *(new)*: unit tests on
  the pure helpers (scale boundaries, tick-rounding, date format, bytes
  format, clamp).
- No new component tests; the widgets are thin SVG renderers.

No new e2e / Playwright tests.

## Implementation notes / gotchas

- The `cumulativeUsers` and `storageBytesPerDay` pre-window seeds are easy
  to miss — both must reflect the state *as of the day before the window
  starts*, not zero. Covered explicitly in the service tests.
- `O3` sparkline runs 30 point-in-time counts via `generate_series`; care
  needed to make sure the predicate is `(resolved_at IS NULL OR
  resolved_at > d)`, not just `resolved_at IS NULL`, so historical points
  reflect threads that were open *at that time*, not threads still open
  now.
- `viewsPerDocHistogram` must left-join from documents → views so the `0`
  bucket includes never-viewed documents.
- `activeUsersPerDay` uses `count(distinct user_id)` per day, *not* the
  sum of per-source distincts — a user uploading and commenting on the
  same day counts once.

## Open questions

None at this time.
