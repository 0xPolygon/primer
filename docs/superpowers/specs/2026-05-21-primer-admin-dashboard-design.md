# Primer Admin Dashboard — Design

**Date:** 2026-05-21
**Status:** Approved

## Goal

A super-simple, read-only admin dashboard that shows top-line usage statistics for Primer: total counts of users, documents, versions, threads, comments, and document views — each with a "last 7 days" delta so growth is visible at a glance.

## Non-goals

- No charts, time-series, or graphs.
- No per-document or per-user breakdowns.
- No role-based access control (any logged-in Polygon user can view).
- No caching layer; counts run live on every request.
- No nav link — discoverability is by URL only (`/admin`).

## Architecture

One Hono endpoint, one React page. No schema changes, no new tables.

```
GET /api/admin/stats   ──►  src/routes/admin.ts          (apps/api)
                              │
                              ▼
                            db.execute(6 × count queries via Promise.all)
                              │
                              ▼
                            AdminStatsResponse DTO

/admin                 ──►  routes/admin.tsx              (apps/web)
                              │
                              ▼
                            useAdminStats() → TanStack Query
                              │
                              ▼
                            3×2 grid of stat cards
```

Auth: inherits the existing `authMiddleware` on `app.use('*', ...)`. No carve-out, no role check.

## Backend

### Endpoint

`GET /api/admin/stats` returns:

```ts
interface AdminStatsResponse {
  users:         { total: number; last7d: number };
  documents:     { total: number; last7d: number };
  versions:      { total: number; last7d: number };
  threads:       { total: number; last7d: number };
  comments:      { total: number; last7d: number };
  documentViews: { total: number; last7d: number };
}
```

### Counting rules

| Metric          | Total filter                       | last7d filter                                      |
|-----------------|------------------------------------|----------------------------------------------------|
| `users`         | all rows                           | `created_at >= NOW() - INTERVAL '7 days'`          |
| `documents`     | `deleted_at IS NULL`               | `+ created_at >= NOW() - INTERVAL '7 days'`        |
| `versions`      | all rows                           | `created_at >= NOW() - INTERVAL '7 days'`          |
| `threads`       | all rows (open + resolved)         | `created_at >= NOW() - INTERVAL '7 days'`          |
| `comments`      | `deleted_at IS NULL` (non-tombstoned) | `+ created_at >= NOW() - INTERVAL '7 days'`     |
| `documentViews` | all rows                           | `viewed_at >= NOW() - INTERVAL '7 days'`           |

Each count is a separate Drizzle `db.select({ c: count() }).from(table).where(...)` query, all twelve executed in parallel via `Promise.all` and assembled into the response shape. Performance is fine — the largest table is a few thousand rows for the foreseeable future.

### File layout

- New: `apps/api/src/routes/admin.ts` — exports `registerAdminRoute(app)` mirroring the other route modules.
- New: `apps/api/src/routes/admin.test.ts` — seeds fixture rows with mixed `created_at` values (some inside the 7-day window, some outside) and asserts both `total` and `last7d` for each metric.
- Modified: `apps/api/src/app.ts` — wires `registerAdminRoute(app)` next to the existing `registerDashboardRoute(app)` call.
- Modified: `packages/shared/src/api.ts` — defines and re-exports the `AdminStatsResponse` interface (alongside `DashboardResponse` and the other API DTOs) so the SPA and the API share one source of truth.

## Frontend

### Route

`/admin` registered in `apps/web/src/App.tsx` alongside the existing routes. Inside the `AppShell`, so the standard Primer header (logo + user menu) is visible. No nav link is added.

### Page

`apps/web/src/routes/admin.tsx`. Uses TanStack Query via a new hook:

```ts
// apps/web/src/queries/admin.ts
export function useAdminStats() {
  return useQuery<AdminStatsResponse>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const r = await fetch('/api/admin/stats');
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    staleTime: 30_000,
  });
}
```

### Layout

Six `<StatCard>` instances in a `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` grid. Each card shows:

```
┌─────────────────────────┐
│ Users                   │   ← label, neutral-600, small
│ 47                      │   ← total, 3xl, neutral-900, semibold
│ +3 this week            │   ← delta, neutral-500, small, only shown when > 0
└─────────────────────────┘
```

If `last7d === 0`, the delta line is rendered but greyed out (`text-neutral-400`) so all cards have the same height. No animation, no icon, no color coding by metric.

Loading state: render six skeleton cards (grey blocks, same size as real cards). Error state: a single red banner "Couldn't load stats — try again." with a retry button.

### `StatCard` component

Lives inline in `routes/admin.tsx` — small enough that a separate file isn't worth it. If a second admin page ever shows up, extract then.

## Testing

- `admin.test.ts` covers the API:
  - Returns zero counts on an empty database.
  - `total` includes old rows; `last7d` excludes rows older than 7 days.
  - `documents.total` and `comments.total` exclude tombstoned rows.
  - Endpoint requires auth (401 without a session) — confirms inheritance from `authMiddleware`.
- Frontend testing is manual. Pull up `/admin` locally after a fresh `pnpm dev`, eyeball that each card matches what's in the database.

## Risks & mitigations

- **Cost of repeated count queries.** Negligible at our scale. If it becomes a problem we add a 60-second cache; we're nowhere close.
- **Anyone can scrape stats.** Acceptable — the data is non-sensitive aggregate counts, and only Polygon employees with Okta sessions can reach it.
- **Hidden URL drift.** Someone might forget `/admin` exists. Acceptable — this is for occasional checks, not a daily tool.

## What gets committed

1. `apps/api/src/routes/admin.ts`
2. `apps/api/src/routes/admin.test.ts`
3. `apps/api/src/app.ts` (wire route)
4. `apps/web/src/routes/admin.tsx`
5. `apps/web/src/queries/admin.ts`
6. `apps/web/src/App.tsx` (register `/admin`)
7. `packages/shared/src/api.ts` (define + export `AdminStatsResponse`)

All as one PR-sized commit.
