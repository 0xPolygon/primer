# HTML Download & Full-Screen View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two viewer-facing actions to the document three-dot menu — "Open full screen" (opens the current version's HTML artifact in a new tab) and "Download HTML" (downloads it as a `.html` file).

**Architecture:** Pure additions to existing files. Menu items are produced by a pure helper (`documentActionsMenu.ts`); filename slugification lives next to the existing `commentsFilename` (`exportComments.ts`); click handlers and the menu render live in `document.tsx`. The artifact API (`/api/versions/:versionId/content`) is unchanged — download is a client-side blob fetch, mirroring the existing comments-export pattern. No server, schema, or auth changes.

**Tech Stack:** TypeScript, React 19, Vite, Vitest. Workspace package manager: pnpm. Web app lives in `apps/web/`.

**Branch:** `feat/html-download-fullscreen` (already created off `master`; spec committed as `389e417`).

**Spec:** `docs/superpowers/specs/2026-06-01-html-download-fullscreen-design.md`.

**Commit ordering rationale:** Extending `MenuItemId` and wiring `document.tsx` are coupled — touching only one breaks typecheck because `onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void>` enforces exhaustive keys. So the menu extension + UI wiring ship together (Task 3). The independent helpers ship first (Tasks 1, 2). Every commit on the branch leaves the workspace green.

---

## File Structure

**Modified:**
- `apps/web/src/lib/documentActionsMenu.ts` — extend `MenuItemId`; insert two new items at the top of `buildMenuItems`'s return.
- `apps/web/src/lib/documentActionsMenu.test.ts` — update ordering expectations; add cases for the new ids.
- `apps/web/src/lib/exportComments.ts` — add `htmlFilename` helper next to `commentsFilename`.
- `apps/web/src/lib/exportComments.test.ts` — add a `describe('htmlFilename')` block.
- `apps/web/src/routes/document.tsx` — add `openFullScreen` and `downloadHtml` handlers; extract a small `showFeedback` helper from the existing `copyComments` toast logic; import `htmlFilename`; wire the two new ids into the existing `onClickFor` record.

**Created:** none.

---

## Task 1: `htmlFilename` helper (TDD)

Ships an unused-but-tested helper. Green commit.

**Files:**
- Modify: `apps/web/src/lib/exportComments.ts`
- Modify: `apps/web/src/lib/exportComments.test.ts`

- [ ] **Step 1: Add failing tests**

In `apps/web/src/lib/exportComments.test.ts`, update the top import line from:

```ts
import { commentsFilename, formatThreadsAsMarkdown } from './exportComments.ts';
```

to:

```ts
import { commentsFilename, formatThreadsAsMarkdown, htmlFilename } from './exportComments.ts';
```

Then append at the very end of the file (after the closing `})` of the existing `describe('commentsFilename', ...)` block):

```ts
describe('htmlFilename', () => {
  it('produces a sluggified filename ending in -v{n}.html', () => {
    expect(htmlFilename({ title: 'Agglayer DVN Paths' }, { versionNumber: 3 })).toBe(
      'agglayer-dvn-paths-v3.html',
    );
  });

  it('handles titles with special characters the same way commentsFilename does', () => {
    expect(htmlFilename({ title: "Carol's Notes (draft)" }, { versionNumber: 1 })).toBe(
      'carol-s-notes-draft-v1.html',
    );
  });

  it('falls back to "document" for an empty slug', () => {
    expect(htmlFilename({ title: '!!!' }, { versionNumber: 2 })).toBe('document-v2.html');
  });

  it('truncates long titles to 60 chars of slug before the suffix', () => {
    const longTitle = 'a'.repeat(120);
    const name = htmlFilename({ title: longTitle }, { versionNumber: 7 });
    expect(name).toBe(`${'a'.repeat(60)}-v7.html`);
  });

  it('uses the same slug as commentsFilename for the same title', () => {
    const title = 'Mixed CASE  with — punctuation!';
    const html = htmlFilename({ title }, { versionNumber: 4 });
    const md = commentsFilename({ title }, { versionNumber: 4 });
    const htmlSlug = html.replace(/-v4\.html$/, '');
    const mdSlug = md.replace(/-v4-comments\.md$/, '');
    expect(htmlSlug).toBe(mdSlug);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @primer/web test src/lib/exportComments.test.ts`

Expected: FAIL — import resolution error for `htmlFilename` (not yet exported).

- [ ] **Step 3: Add the helper**

In `apps/web/src/lib/exportComments.ts`, append at the end of the file (after `commentsFilename`):

```ts
/** Sluggify the doc title for a filesystem-safe HTML download filename.
 *  Uses the same slug rule as commentsFilename — diverges only in the
 *  suffix. */
export function htmlFilename(doc: DocInfo, version: VersionInfo): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'document'}-v${version.versionNumber}.html`;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter @primer/web test src/lib/exportComments.test.ts`

Expected: PASS (all existing cases plus the 5 new `htmlFilename` cases).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @primer/web typecheck`

Expected: PASS. (The helper isn't yet referenced from `document.tsx`, so no consumer breakage.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/exportComments.ts apps/web/src/lib/exportComments.test.ts
git commit -m "feat(web): add htmlFilename helper for HTML downloads

Mirrors commentsFilename but emits {slug}-v{n}.html. A parity test
asserts both helpers agree on the slug for the same title so they
can't drift. Unused until the menu wiring lands."
```

---

## Task 2: Extract `showFeedback` helper in `document.tsx` (refactor, no behavior change)

Pure refactor so Task 3's `downloadHtml` can reuse the toast slot without duplicating timer-clear logic. Green commit.

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Read the existing `copyComments` function**

Open `apps/web/src/routes/document.tsx`. Locate the `async function copyComments()` around line 238. Note these two pieces of toast logic inside it:

```ts
if (copyFeedbackTimerRef.current !== null) {
  clearTimeout(copyFeedbackTimerRef.current);
}
setCopyFeedback(
  result === 'failed'
    ? { kind: 'error', message: 'Copy failed. Try Download instead.' }
    : { kind: 'success', message: 'Copied' }
);
copyFeedbackTimerRef.current = setTimeout(() => {
  setCopyFeedback(null);
  copyFeedbackTimerRef.current = null;
}, result === 'failed' ? 3000 : 2000);
```

- [ ] **Step 2: Add the `showFeedback` helper inside the component**

In `document.tsx`, immediately above the existing `function exportComments()` declaration (around line 216), add:

```tsx
function showFeedback(
  fb: { kind: 'success' | 'error'; message: string },
  dismissMs: number = fb.kind === 'error' ? 3000 : 2000,
) {
  if (copyFeedbackTimerRef.current !== null) {
    clearTimeout(copyFeedbackTimerRef.current);
  }
  setCopyFeedback(fb);
  copyFeedbackTimerRef.current = setTimeout(() => {
    setCopyFeedback(null);
    copyFeedbackTimerRef.current = null;
  }, dismissMs);
}
```

`showFeedback` is declared inside `DocumentPage` so it closes over `copyFeedbackTimerRef` and `setCopyFeedback`. It is not memoized — it's only called from event handlers, never passed as a prop.

- [ ] **Step 3: Replace the inline toast logic in `copyComments` with a call to `showFeedback`**

In the same file, the `copyComments` function should now read in full:

```ts
async function copyComments() {
  if (!docQuery.data) return;
  const md = formatThreadsAsMarkdown(
    { title: docQuery.data.document.title },
    { versionNumber: currentVersionNumber },
    threads,
  );
  const result = await copyText(md);
  showFeedback(
    result === 'failed'
      ? { kind: 'error', message: 'Copy failed. Try Download instead.' }
      : { kind: 'success', message: 'Copied' },
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @primer/web typecheck`

Expected: PASS.

- [ ] **Step 5: Run the full web test suite**

Run: `pnpm --filter @primer/web test`

Expected: PASS. (No `document.tsx` unit tests exercise the toast directly, but the broader suite should stay green.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/document.tsx
git commit -m "refactor(web): extract showFeedback helper from copyComments

Pulls toast-set + timer-clear out of copyComments so the next commit's
downloadHtml can reuse the same slot for error messages. Pure refactor —
copy behavior is unchanged."
```

---

## Task 3: Menu helper extension + UI wiring (single coupled commit)

Extends `MenuItemId`, updates `buildMenuItems`, updates the menu tests, wires both new ids in `document.tsx`, and adds the `openFullScreen` and `downloadHtml` handlers. All in one commit because the type-level coupling between `MenuItemId` and `onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void>` means partial changes break typecheck.

**Files:**
- Modify: `apps/web/src/lib/documentActionsMenu.ts`
- Modify: `apps/web/src/lib/documentActionsMenu.test.ts`
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Update the menu tests for the new ordering and ids**

Replace the body of `apps/web/src/lib/documentActionsMenu.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { buildMenuItems, type MenuItemId } from './documentActionsMenu.ts';

const ids = (items: { id: MenuItemId }[]) => items.map((i) => i.id);

describe('buildMenuItems', () => {
  it('shows HTML actions, separator, then comment actions for a non-uploader', () => {
    const items = buildMenuItems({ isUploader: false });
    expect(ids(items)).toEqual([
      'open-fullscreen',
      'download-html',
      'separator',
      'copy',
      'download',
    ]);
  });

  it('appends a separator and delete for an uploader', () => {
    const items = buildMenuItems({ isUploader: true });
    expect(ids(items)).toEqual([
      'open-fullscreen',
      'download-html',
      'separator',
      'copy',
      'download',
      'separator',
      'delete',
    ]);
  });

  it('marks the delete item as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    const del = items.find((i) => i.id === 'delete');
    expect(del?.destructive).toBe(true);
  });

  it('does not mark non-destructive items as destructive', () => {
    const items = buildMenuItems({ isUploader: true });
    for (const id of ['open-fullscreen', 'download-html', 'copy', 'download'] as const) {
      expect(items.find((i) => i.id === id)?.destructive).toBeFalsy();
    }
  });

  it('labels every non-separator item with a string', () => {
    const items = buildMenuItems({ isUploader: true });
    for (const item of items) {
      if (item.id === 'separator') continue;
      expect(typeof item.label).toBe('string');
      expect(item.label!.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the menu tests and verify they fail**

Run: `pnpm --filter @primer/web test src/lib/documentActionsMenu.test.ts`

Expected: FAIL. Failures will reference the missing `'open-fullscreen'` / `'download-html'` ids and the wrong ordering.

- [ ] **Step 3: Extend `MenuItemId` and update `buildMenuItems`**

Replace the entire contents of `apps/web/src/lib/documentActionsMenu.ts` with:

```ts
export type MenuItemId =
  | 'open-fullscreen'
  | 'download-html'
  | 'copy'
  | 'download'
  | 'separator'
  | 'delete';

export interface MenuItem {
  id: MenuItemId;
  label?: string;
  destructive?: boolean;
}

export interface MenuInput {
  isUploader: boolean;
}

/** Pure function: given who's viewing, return the ordered menu items. The
 *  caller maps each item to a click handler. */
export function buildMenuItems({ isUploader }: MenuInput): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'open-fullscreen', label: 'Open full screen' },
    { id: 'download-html', label: 'Download HTML' },
    { id: 'separator' },
    { id: 'copy', label: 'Copy comments as Markdown' },
    { id: 'download', label: 'Download comments as Markdown' },
  ];
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: 'Delete document…', destructive: true });
  }
  return items;
}
```

- [ ] **Step 4: Run the menu tests and verify they pass**

Run: `pnpm --filter @primer/web test src/lib/documentActionsMenu.test.ts`

Expected: PASS (all 5 cases).

- [ ] **Step 5: Update the `exportComments` import in `document.tsx`**

In `apps/web/src/routes/document.tsx`, find the existing import:

```ts
import { commentsFilename, formatThreadsAsMarkdown } from '../lib/exportComments.ts';
```

Replace it with:

```ts
import { commentsFilename, formatThreadsAsMarkdown, htmlFilename } from '../lib/exportComments.ts';
```

- [ ] **Step 6: Add the `openFullScreen` and `downloadHtml` handlers**

In `document.tsx`, immediately above the existing `function exportComments()` declaration (and *after* the `showFeedback` helper added in Task 2), add:

```ts
function openFullScreen() {
  if (!currentVersionId) return;
  window.open(
    `/api/versions/${currentVersionId}/content`,
    '_blank',
    'noopener,noreferrer',
  );
}

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
  } catch {
    showFeedback({ kind: 'error', message: 'Download failed. Try again.' });
  }
}
```

- [ ] **Step 7: Wire the new ids into the menu `onClickFor` record**

Locate the `onClickFor` declaration in the menu render block (around `document.tsx:485`). Replace it with:

```tsx
const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
  'open-fullscreen': () => {
    setActionsMenuState('closed');
    openFullScreen();
  },
  'download-html': () => {
    setActionsMenuState('closed');
    void downloadHtml();
  },
  copy: () => {
    setActionsMenuState('closed');
    void copyComments();
  },
  download: () => {
    setActionsMenuState('closed');
    exportComments();
  },
  delete: () => setActionsMenuState('confirm'),
};
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @primer/web typecheck`

Expected: PASS. The `Record<Exclude<MenuItemId, 'separator'>, () => void>` now has exhaustive coverage for the extended `MenuItemId`.

- [ ] **Step 9: Run the full web test suite**

Run: `pnpm --filter @primer/web test`

Expected: PASS — all existing tests plus the new menu and filename tests.

- [ ] **Step 10: Manually verify the feature in a running dev server**

Start the stack the project's usual way. (Do NOT use `wrangler dev` per the user's NixOS notes; use `pnpm --filter @primer/web dev` for the web app plus the API's normal dev command from `apps/api/package.json`.) Then in a browser:

1. Open a document as a *non-uploader* viewer. Confirm the three-dot menu shows, top to bottom: **Open full screen, Download HTML, ─── , Copy comments as Markdown, Download comments as Markdown** (no Delete).
2. As the *uploader*: confirm the same five items plus a second separator and **Delete document…** in red.
3. Click **Open full screen**: a new browser tab opens at `/api/versions/{id}/content` showing the artifact bare (no Primer chrome).
4. Switch to a pinned older version via the version selector. Click **Open full screen** — the new tab shows *that* version, not the latest. Confirm by inspecting the URL.
5. Click **Download HTML** on the latest version: a file named `{slug}-v{n}.html` appears in Downloads. Open it locally and confirm it renders the artifact.
6. With the pinned older version still selected, click **Download HTML**: the downloaded filename's `v{n}` matches the pinned version.
7. Open DevTools → Network → set to "Offline". Click **Download HTML**. Confirm the red error toast "Download failed. Try again." appears and disappears after ~3 seconds. Set back to "Online".

If any step fails, fix it in this task before committing.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/lib/documentActionsMenu.ts apps/web/src/lib/documentActionsMenu.test.ts apps/web/src/routes/document.tsx
git commit -m "feat(web): add Open full screen and Download HTML menu items

Extends the document menu helper with HTML actions ordered above the
comment-export items, separated by a divider. Open full screen does a
window.open of the current version's content URL with
noopener,noreferrer. Download HTML fetches the same URL into a blob and
triggers a {slug}-v{n}.html download via htmlFilename, with errors
surfaced through the existing toast slot. Both target the currently
viewed version (pinned or latest) and are available to all viewers.
Manually verified on latest + pinned-older versions and the offline
failure path."
```

---

## Task 4: Final verification before handoff

**Files:** none (verification only).

- [ ] **Step 1: Run typecheck across the workspace**

Run: `pnpm -r typecheck`

Expected: PASS in every package.

- [ ] **Step 2: Run all tests**

Run: `pnpm -r test`

Expected: PASS.

- [ ] **Step 3: Review the diff**

Run: `git log --oneline master..HEAD`

Expected: 4 commits on `feat/html-download-fullscreen`:

1. `docs: spec for HTML download and full-screen menu items` (from brainstorming)
2. `feat(web): add htmlFilename helper for HTML downloads`
3. `refactor(web): extract showFeedback helper from copyComments`
4. `feat(web): add Open full screen and Download HTML menu items`

Run: `git diff master..HEAD --stat`

Expected: changes only in `apps/web/src/lib/documentActionsMenu.ts`, `apps/web/src/lib/documentActionsMenu.test.ts`, `apps/web/src/lib/exportComments.ts`, `apps/web/src/lib/exportComments.test.ts`, `apps/web/src/routes/document.tsx`, and `docs/superpowers/specs/2026-06-01-html-download-fullscreen-design.md`. No API/schema/storage files touched.

- [ ] **Step 4: Stop**

Do NOT push. Per the user's standing instruction, `master` auto-deploys to Railway, and any push requires an explicit greenlight in the turn. Hand the branch back to the user for review and a push/merge decision.
