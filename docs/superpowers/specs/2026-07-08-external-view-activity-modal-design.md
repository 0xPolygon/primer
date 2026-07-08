# External View Activity Modal — Design

**Date:** 2026-07-08
**Status:** Approved design
**Builds on:** `2026-07-07-external-document-sharing-design.md`

## Summary

Give document owners/editors a compact audit-log modal showing external view
activity for a shared document — who viewed, which version, when — sourced
from the existing `external_views` table. Sales teams use it to gauge
engagement from their external targets.

## Decisions

- **One log for the whole share** (not per-recipient): a single "View
  activity" action in the External Sharing panel opens a modal listing all
  view events newest-first, each row showing recipient email + version
  number + timestamp.
- **Dedicated endpoint**, fetched only while the modal is open — the panel's
  existing payload stays lean and the log is fresh on demand.
- Views from **since-revoked recipients are included** — it is an audit log;
  history must not vanish on revoke.
- **IP and user-agent are not exposed** in the response. They remain in the
  DB for forensic use but are noise for this audience and mildly
  privacy-sensitive.
- Latest **200** events, plus a `total` count so the UI can say "showing
  latest 200 of N" when truncated. No pagination in v1.

## API

`GET /api/documents/:docId/external-share/views` (in
`apps/api/src/routes/externalShareAdmin.ts`):

- Same gate as every other external-share admin route: non-readers 404,
  readers without `canManage` 403; 404 when the doc has no active share.
- Response (`@primer/shared` types):

```ts
export interface ExternalViewEventDto {
  id: string;
  email: string;         // recipient email at time of viewing (from external_recipients)
  versionNumber: number; // joined from versions
  viewedAt: string;      // ISO
}

export interface ExternalShareViewsResponse {
  views: ExternalViewEventDto[]; // ordered viewedAt DESC, LIMIT 200
  total: number;                 // full count for the share
}
```

- Query joins `external_views` → `external_recipients` (scoped to the active
  share's id) → `versions`.

## Web

- `useExternalShareViews(docId, enabled)` hook in
  `apps/web/src/queries/externalShare.ts`; `enabled` is true only while the
  modal is open.
- New `ViewActivityModal` component (`apps/web/src/components/`), following
  ShareModal's dialog conventions: fixed overlay, centered card,
  `role="dialog"` + `aria-modal`, ESC and backdrop-click close. Because it
  stacks above the ShareModal (which also closes on ESC), its ESC handler
  registers in the capture phase and stops propagation so one press closes
  only the top modal.
- Rows: `email · v3 · 2h ago` using the shared `lib/relativeTime.ts`, with
  the absolute timestamp in the row's `title` attribute.
- States: loading, error ("Couldn't load activity"), empty ("No views yet"),
  and a footer "Showing latest 200 of N views" when `total > views.length`.
- Entry point: a "View activity" button in the ExternalSharePanel next to
  the recipients list, in the panel's existing bordered-button style.

## Testing

- API (`externalShareAdmin.test.ts`): manage-gate (403 for non-manager),
  404 without an active share, happy path asserting newest-first ordering,
  correct email/version join, inclusion of a revoked recipient's historical
  views, and `total` matching the row count.
- Web: no component render tests (repo convention); the hook follows the
  existing query patterns.

## Out of scope

- Pagination / infinite scroll, per-recipient filtering, CSV export,
  exposing IP/user-agent in the UI.
