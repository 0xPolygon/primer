# HTML Download & Full-Screen View — Design

**Date:** 2026-06-01
**Status:** Approved

## Goal

Two small actions added to the document page's three-dot menu:

1. **Open full screen** — opens the currently viewed version's HTML artifact in a new browser tab/window, free of the Primer chrome (no sidebar, no header).
2. **Download HTML** — downloads the same artifact as a `.html` file to the user's machine.

Both target the *currently viewed* version (which may be a pinned older version, not always the latest).

## Non-goals

- Server-side `content-disposition: attachment` on the artifact endpoint. The existing `/api/versions/:versionId/content` route stays unchanged — download is a client-side blob, matching the existing comments-export pattern.
- Print-to-PDF, share-via-link, copy-link, or embed flows.
- Bundling assets / inlining external scripts referenced by the artifact for offline use. The downloaded `.html` is exactly what the server serves; any `cdn.tailwindcss.com`-style script tags will still need network when opened.
- New permissions. These are purely viewing actions, available to any viewer (same policy as the existing comment-export items).
- A separate "open in same tab" variant. Always opens a new tab.

## Architecture

### Menu (`apps/web/src/lib/documentActionsMenu.ts`)

Extend `MenuItemId` with two new ids:

```ts
export type MenuItemId =
  | 'open-fullscreen'
  | 'download-html'
  | 'separator'
  | 'copy'
  | 'download'
  | 'delete';
```

Update `buildMenuItems({ isUploader })` to return, in order:

1. `{ id: 'open-fullscreen', label: 'Open full screen' }`
2. `{ id: 'download-html', label: 'Download HTML' }`
3. `{ id: 'separator' }`
4. `{ id: 'copy', label: 'Copy comments as Markdown' }`
5. `{ id: 'download', label: 'Download comments as Markdown' }`
6. `{ id: 'separator' }` *(only when `isUploader`)*
7. `{ id: 'delete', label: 'Delete document…', destructive: true }` *(only when `isUploader`)*

The separator between HTML and comment actions is always rendered. The separator before Delete is only rendered for uploaders (existing behavior).

Rationale for ordering: HTML actions act on the document itself; comment actions act on derived data. Putting document actions first matches how a user mentally indexes "the thing I'm looking at" before "the things people said about it."

### Filename helper (`apps/web/src/lib/exportComments.ts`)

Add a sibling helper to `commentsFilename`:

```ts
export function htmlFilename(doc: DocInfo, version: VersionInfo): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}-v${version.versionNumber}.html`;
}
```

Same sluggify rule as `commentsFilename` — diverges only in the suffix (`-v{n}.html` instead of `-v{n}-comments.md`). The duplicated slug logic is fine at this scale; if a third caller appears we extract it then. The helper lives in `exportComments.ts` to keep filename rules co-located.

### Click handlers (`apps/web/src/routes/document.tsx`)

Add two handlers alongside the existing `copyComments` and `exportComments`:

**`openFullScreen()`** — synchronous:

```ts
function openFullScreen() {
  if (!currentVersionId) return;
  window.open(
    `/api/versions/${currentVersionId}/content`,
    '_blank',
    'noopener,noreferrer',
  );
}
```

No special window features (no size/position) — the user's browser decides whether it's a tab or a window. `noopener,noreferrer` because the artifact is sandboxed-by-CSP but we don't need a `window.opener` link anyway.

**`downloadHtml()`** — async, mirrors `exportComments`:

```ts
async function downloadHtml() {
  if (!docQuery.data || !currentVersionId) return;
  try {
    const res = await fetch(`/api/versions/${currentVersionId}/content`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = htmlFilename(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
    );
    a.style.display = 'none';
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    showFeedback({ kind: 'error', message: 'Download failed. Try again.' });
  }
}
```

Failure path: reuse the existing `copyFeedback` toast slot. To support this without entangling state, extract the toast-set + timer-clear logic out of `copyComments` into a small `showFeedback({kind, message})` helper closing over `copyFeedbackTimerRef` and `setCopyFeedback`. Then `copyComments` calls `showFeedback` too — net wins clarity. (The state name stays `copyFeedback` — that's fine, the variable name is internal.)

`'open-fullscreen'` has no error path worth surfacing — popup blockers may swallow it, but the user clicked the menu so the browser should permit it. Don't add toast noise here.

### Wiring in the menu render

In the existing `onClickFor` record in `document.tsx`, add the two new ids:

```ts
const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
  'open-fullscreen': () => {
    setActionsMenuState('closed');
    openFullScreen();
  },
  'download-html': () => {
    setActionsMenuState('closed');
    void downloadHtml();
  },
  copy: /* unchanged */,
  download: /* unchanged */,
  delete: () => setActionsMenuState('confirm'),
};
```

Pattern is identical to the existing handlers: close the menu, then run the action (async download is fire-and-forget; errors land in the toast).

## Testing

### Unit — `documentActionsMenu.test.ts`

Add cases covering:

- For a non-uploader: returns exactly `[open-fullscreen, download-html, separator, copy, download]` in that order.
- For an uploader: returns the above plus `separator, delete` at the end.
- No accidental ordering regressions for existing items.

### Unit — `exportComments.test.ts`

Add cases for `htmlFilename`:

- Standard title → `my-doc-v3.html`.
- Title with punctuation/spaces → sluggified the same way as `commentsFilename`.
- Title that sluggifies to empty → `document-v3.html`.
- Long title → truncated to 60 chars before suffix.

(Lift expectations from existing `commentsFilename` tests — the slug behavior must stay identical.)

### Manual verification

- Non-uploader viewer: menu shows the two new items; comment items still work; no Delete.
- Uploader: all items present in the right order; Delete confirmation still works.
- Open full screen on a pinned older version opens *that* version, not the latest.
- Download HTML on a pinned older version downloads *that* version, with filename containing the right `v{n}`.
- Network failure (DevTools throttle to offline) on Download HTML shows the error toast and clears after 3s.

No new e2e tests. The two click handlers are thin wrappers over `window.open`/blob download; the unit-level coverage on the menu structure + filename is what's load-bearing.

## Files touched

- `apps/web/src/lib/documentActionsMenu.ts` — extend `MenuItemId`, update `buildMenuItems`.
- `apps/web/src/lib/documentActionsMenu.test.ts` — add ordering cases.
- `apps/web/src/lib/exportComments.ts` — add `htmlFilename`.
- `apps/web/src/lib/exportComments.test.ts` — add `htmlFilename` cases.
- `apps/web/src/routes/document.tsx` — `openFullScreen`, `downloadHtml`, `showFeedback` extraction, wire the two new ids into `onClickFor`.

No API, schema, or storage changes.

## Risks & mitigations

- **Popup blockers** on `window.open` — clicking a menu item is a direct user gesture, so this should not be flagged. If it ever is, we can fall back to setting `location.href` on a hidden `<a target="_blank">` — defer until reported.
- **Filename slug drift** — two helpers with the same slug rule. Tests assert both helpers agree on the slug for the same title. If they diverge in the future, the test catches it.
- **Large artifacts** in Download HTML — the fetch buffers the whole response as a blob in memory. Primer artifacts are small (single self-contained HTML files), so this is fine. No streaming download needed.
