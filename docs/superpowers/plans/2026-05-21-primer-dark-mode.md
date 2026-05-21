# Dark Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a three-state (light / dark / system) dark mode to the Primer web app, toggled via a header icon button and persisted to localStorage.

**Architecture:** Tailwind v4 with a custom `@variant dark` driven by a `.dark` class on `<html>`. A `useTheme()` hook owns the preference state and writes the class; a pre-paint inline script in `index.html` applies the class synchronously before React mounts to prevent a flash of light theme. Component-level changes are mechanical: each color class (`bg-white`, `text-neutral-700`, etc.) gets a `dark:` partner per the canonical mapping table.

**Tech Stack:** Tailwind 4.2.4, React 19, plain `localStorage` + `matchMedia` for OS preference detection.

**Spec:** `docs/superpowers/specs/2026-05-21-primer-dark-mode-design.md`

---

## Canonical color mapping (definitive reference for Tasks 3–5)

Every component update applies this exact table — no inventing new mappings, no skipping cases. Keep one rule in mind: **`bg-neutral-900` primary buttons stay dark in both themes**; do NOT add a `dark:` partner to those.

| Light class                              | Dark partner to add                       |
|------------------------------------------|-------------------------------------------|
| `bg-white`                               | `dark:bg-neutral-900`                     |
| `bg-neutral-50`                          | `dark:bg-neutral-900`                     |
| `bg-neutral-100`                         | `dark:bg-neutral-800`                     |
| `bg-neutral-200`                         | `dark:bg-neutral-700`                     |
| `bg-neutral-900` (primary button)        | **unchanged**                             |
| `hover:bg-neutral-50`                    | `dark:hover:bg-neutral-800`               |
| `hover:bg-neutral-100`                   | `dark:hover:bg-neutral-800`               |
| `hover:bg-neutral-800` (primary button)  | **unchanged**                             |
| `text-neutral-900`                       | `dark:text-neutral-100`                   |
| `text-neutral-800`                       | `dark:text-neutral-200`                   |
| `text-neutral-700`                       | `dark:text-neutral-300`                   |
| `text-neutral-600`                       | `dark:text-neutral-400`                   |
| `text-neutral-500`                       | **unchanged** (already mid-tone)          |
| `text-neutral-400`                       | `dark:text-neutral-500`                   |
| `hover:text-neutral-900`                 | `dark:hover:text-neutral-100`             |
| `hover:text-neutral-700`                 | `dark:hover:text-neutral-300`             |
| `text-white` (on primary buttons)        | **unchanged**                             |
| `border-neutral-100`                     | `dark:border-neutral-800`                 |
| `border-neutral-200`                     | `dark:border-neutral-800`                 |
| `border-neutral-300`                     | `dark:border-neutral-700`                 |
| `bg-yellow-50`                           | `dark:bg-amber-900/20`                    |
| `border-yellow-200`                      | `dark:border-amber-800`                   |
| `border-yellow-300`                      | `dark:border-amber-700`                   |
| `bg-yellow-300` (the dot indicator)      | **unchanged** (readable on both backgrounds) |
| `text-amber-900`                         | `dark:text-amber-200`                     |
| `text-amber-700`                         | `dark:text-amber-300`                     |
| `bg-amber-100`                           | `dark:bg-amber-900/30`                    |
| `border-amber-300`                       | `dark:border-amber-700`                   |
| `border-amber-700`                       | `dark:border-amber-600`                   |
| `hover:bg-amber-100`                     | `dark:hover:bg-amber-900/30`              |
| `bg-red-50`                              | `dark:bg-red-900/20`                      |
| `bg-red-100`                             | `dark:bg-red-900/30`                      |
| `text-red-600`                           | `dark:text-red-400`                       |
| `text-red-700`                           | `dark:text-red-300`                       |
| `bg-red-600` (cancel/destructive button) | **unchanged** (readable on both backgrounds) |
| `hover:bg-red-700`                       | **unchanged**                             |
| `border-red-200`                         | `dark:border-red-800`                     |
| `border-red-400`                         | `dark:border-red-700`                     |
| `bg-black/30` (modal scrim)              | **unchanged** (works in both themes)      |

---

## Task 1: Substrate — variant config, hook, pre-paint script

This task lays the rails. No visible UI change yet — even if the OS prefers dark, components without `dark:` variants stay light-looking. The Done state is "the page renders identically to before but `.dark` is toggleable on `<html>`".

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/index.html`
- Create: `apps/web/src/lib/useTheme.ts`

- [ ] **Step 1: Configure the `dark:` variant**

Open `apps/web/src/index.css`. Currently it contains one line. Replace with:

```css
@import 'tailwindcss';
@custom-variant dark (&:where(.dark, .dark *));
```

- [ ] **Step 2: Add the pre-paint script + dark body classes to `index.html`**

Open `apps/web/index.html`. Replace the existing `<head>` and `<body>` block so the file reads:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Primer</title>
    <script>
      (function () {
        try {
          var p = localStorage.getItem('primer.theme') || 'system';
          var dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
          if (dark) document.documentElement.classList.add('dark');
        } catch (_) { /* localStorage may be unavailable */ }
      })();
    </script>
  </head>
  <body class="bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Two changes: (1) the inline pre-paint `<script>` in `<head>`; (2) `dark:bg-neutral-950 dark:text-neutral-100` on `<body>`. (We use `neutral-950` on the body as the page-edge color, slightly darker than `neutral-900` cards so cards have a subtle elevation.)

- [ ] **Step 3: Create the `useTheme` hook**

Create `apps/web/src/lib/useTheme.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';

export type Preference = 'light' | 'dark' | 'system';
export type Effective = 'light' | 'dark';

const STORAGE_KEY = 'primer.theme';

function readPreference(): Preference {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* localStorage unavailable */
  }
  return 'system';
}

function computeEffective(preference: Preference): Effective {
  if (preference === 'light' || preference === 'dark') return preference;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyEffective(effective: Effective) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', effective === 'dark');
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<Preference>(readPreference);
  const [effective, setEffective] = useState<Effective>(() => computeEffective(readPreference()));

  useEffect(() => {
    applyEffective(effective);
  }, [effective]);

  useEffect(() => {
    setEffective(computeEffective(preference));
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setEffective(mql.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback((next: Preference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  return { preference, effective, setPreference };
}
```

- [ ] **Step 4: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: all three projects report `Done`. No new errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/index.css apps/web/index.html apps/web/src/lib/useTheme.ts
git commit -m "feat(web): dark mode substrate — variant + hook + pre-paint script"
```

---

## Task 2: ThemeToggle component + AppShell integration

This adds the user-facing control. After this commit, clicking the header icon cycles light → dark → system and the header itself (plus body, from Task 1) responds; routes/components are still light-only and will get dark variants in Tasks 3–5.

**Files:**
- Create: `apps/web/src/components/ThemeToggle.tsx`
- Modify: `apps/web/src/AppShell.tsx`

- [ ] **Step 1: Create the ThemeToggle component**

Create `apps/web/src/components/ThemeToggle.tsx`:

```tsx
import { useTheme, type Preference } from '../lib/useTheme.ts';

const NEXT: Record<Preference, Preference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const LABEL: Record<Preference, string> = {
  light: 'Theme: Light — click for Dark',
  dark: 'Theme: Dark — click for System',
  system: 'Theme: System — click for Light',
};

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const Icon = preference === 'light' ? SunIcon : preference === 'dark' ? MoonIcon : SystemIcon;

  return (
    <button
      type="button"
      onClick={() => setPreference(NEXT[preference])}
      aria-label={LABEL[preference]}
      title={LABEL[preference]}
      className="flex h-7 w-7 items-center justify-center rounded text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      <Icon />
    </button>
  );
}
```

- [ ] **Step 2: Wire ThemeToggle into AppShell and add dark variants to AppShell**

Open `apps/web/src/AppShell.tsx`. Replace the entire file with:

```tsx
import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './components/UserMenu.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { PrimerIcon } from './components/PrimerIcon.tsx';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3 flex items-center justify-between">
        <Link
          to="/"
          className="flex items-center gap-2 font-semibold text-neutral-800 dark:text-neutral-200"
        >
          <PrimerIcon size={22} className="text-neutral-700 dark:text-neutral-300" />
          <span>Primer</span>
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

Three changes vs. the current file: imported `ThemeToggle`, rendered it inside a new `<div className="flex items-center gap-1">` wrapper next to `<UserMenu>`, and added `dark:` partners to the header's `border-neutral-200`, the Link's `text-neutral-800`, and the icon's `text-neutral-700`.

- [ ] **Step 3: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: `Done`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ThemeToggle.tsx apps/web/src/AppShell.tsx
git commit -m "feat(web): theme toggle button + AppShell dark variants"
```

---

## Task 3: Dark variants for routes (6 files)

Apply the canonical mapping table from the top of this plan to every color class in each listed file. Do NOT add `dark:` partners to classes marked **unchanged** in the table.

Use `Edit` with `replace_all` on each unique class fragment. After editing each file, save and move on. Don't run the dev server between files — one batched verification at the end.

**Files:**

### File 1: `apps/web/src/routes/home.tsx`

Color classes present (apply mapping table to each):
- `border-neutral-200` (3 occurrences — header underline, section dividers)
- `border-neutral-300` (button border)
- `bg-white` (button)
- `text-neutral-700` (button)
- `hover:bg-neutral-50` (button hover)
- `bg-neutral-900` (primary button — **unchanged**, no dark partner)
- `text-white` (primary button — **unchanged**)
- `hover:bg-neutral-800` (primary button — **unchanged**)
- `text-neutral-500` (loading text, span labels — **unchanged**)
- `text-red-600` (error)
- `text-neutral-900` (h2 titles)
- `text-neutral-600` (blockquote text)
- `text-neutral-400` (italic citation, "no description")
- `hover:text-neutral-900` (Link "Upload your first one")

- [ ] **File 1 done:** every color class above except the **unchanged** rows now has its `dark:` partner per the mapping table.

### File 2: `apps/web/src/routes/upload.tsx`

Color classes present:
- `border-neutral-300` (text input + textarea + Cancel button)
- `bg-white` (Cancel button)
- `text-neutral-700` (Cancel button)
- `hover:bg-neutral-50` (Cancel button hover)
- `bg-neutral-900` (Upload button — **unchanged**)
- `hover:bg-neutral-800` (Upload button — **unchanged**)
- `text-white` (Upload button — **unchanged**)
- `text-red-600` (error)

- [ ] **File 2 done.**

### File 3: `apps/web/src/routes/document.tsx`

Color classes present (this is the largest file):
- `border-neutral-200` (header underline)
- `border-neutral-300` (multiple button borders, ⋯ menu border, confirm box border)
- `bg-white` (multiple buttons + ⋯ menu background + confirm box background)
- `text-neutral-700` (multiple buttons + menu items)
- `hover:bg-neutral-50` (multiple button hovers)
- `text-neutral-900` (modal title `h2`)
- `text-neutral-500` (uploader info, secondary text — **unchanged**)
- `text-neutral-600` (paragraph text)
- `bg-neutral-900` (active pick-mode button, primary buttons — **unchanged**)
- `hover:bg-neutral-800` (primary button hover — **unchanged**)
- `text-white` (primary button text + bottom-bar selection pill text — **unchanged**)
- `border-yellow-200` (read-only banner border)
- `bg-yellow-50` (read-only banner background)
- `text-amber-900` (read-only banner text)
- `border-amber-700` (read-only "Switch to latest" button)
- `hover:bg-amber-100` (read-only button hover)
- `text-red-600` (error text)
- `bg-red-600` (active pick-mode button — destructive — **unchanged**)
- `bg-red-50` (delete confirmation hover background on ⋯ menu)
- `text-red-600` (delete menu item text)
- `hover:bg-red-50` (delete menu item hover)
- `hover:bg-red-700` (delete button hover — **unchanged**)
- The selection-pill `bg-neutral-900 text-white shadow-lg` (line 487-491 area) — **unchanged**
- `border-neutral-700` inside the selection pill (the × button) — **unchanged** (it's on dark background already)

Also: the section that reads `border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800` on the selection-pill × button is already styled for dark; leave it.

- [ ] **File 3 done.**

### File 4: `apps/web/src/routes/admin.tsx`

Color classes present:
- `border-neutral-200` (stat cards, header underline, skeleton cards)
- `bg-white` (stat cards, skeleton cards)
- `text-neutral-600` (label, subtitle)
- `text-neutral-900` (number)
- `text-neutral-500` (delta when last7d > 0)
- `text-neutral-400` (delta when last7d === 0)
- `bg-neutral-200` (skeleton blocks)
- `border-red-200` (error banner border)
- `bg-red-50` (error banner background)
- `text-red-700` (error banner text)

- [ ] **File 4 done.**

### File 5: `apps/web/src/routes/devHarness.tsx`

Color classes present:
- `border-neutral-200` (selection box, anchor list, log items, pending pick box)
- `bg-neutral-900` (Save buttons, Enter pick mode — **unchanged**)
- `text-white` (Save buttons — **unchanged**)
- `bg-red-600` (Exit pick mode button — **unchanged**)
- `text-neutral-500` (timestamps, "No selection" hint — **unchanged**)
- `text-neutral-600` (anchor preview text)

Note: there are several `border px-2` / `border px-3` (no color modifier) — leave those alone, Tailwind defaults the border color and the `dark:` variant inherits naturally.

- [ ] **File 5 done.**

### File 6: `apps/web/src/routes/notFound.tsx`

Color classes present:
- `text-neutral-600`

This file is a single line. Apply the mapping.

- [ ] **File 6 done.**

- [ ] **Step: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: `Done`.

- [ ] **Step: Commit**

```bash
git add apps/web/src/routes/home.tsx apps/web/src/routes/upload.tsx apps/web/src/routes/document.tsx apps/web/src/routes/admin.tsx apps/web/src/routes/devHarness.tsx apps/web/src/routes/notFound.tsx
git commit -m "feat(web): dark variants for routes"
```

---

## Task 4: Dark variants for comment family (5 files)

**Files:**

### File 1: `apps/web/src/components/CommentSidebar.tsx`

Color classes present:
- `border-neutral-200` (sidebar borders, header underline)
- `border-neutral-300` (collapse/expand button)
- `bg-white` (collapsed sidebar, expanded sidebar, expand button)
- `text-neutral-600` (header)
- `text-neutral-500` ("No comments yet" message, collapse button — **unchanged** where applicable; check the mapping)
- `hover:text-neutral-900` (collapse button)
- `text-neutral-900` (thread count)
- `hover:bg-neutral-50` (expand button hover)
- `border-amber-300` (badge border on collapsed sidebar)
- `bg-amber-100` (badge background on collapsed sidebar)
- `text-neutral-700` (badge text)
- `bg-yellow-300` (anchor dot — **unchanged**)
- `bg-neutral-300` (resolved-thread dot — **unchanged**, mid-tone neutral works on both backgrounds)

- [ ] **File 1 done.**

### File 2: `apps/web/src/components/ThreadCard.tsx`

Color classes present:
- `border-neutral-100` (card divider + footer divider — apply `dark:border-neutral-800`)
- `border-neutral-200` (dashed reply divider)
- `text-neutral-400` (icon button base + "(edited)" italic)
- `hover:bg-neutral-100` (icon button hover + footer button hover)
- `hover:text-neutral-700` (icon button hover text)
- `text-neutral-600` (footer button + anchor preview italic)
- `hover:text-neutral-900` (footer button hover text)
- `text-neutral-500` (comment header metadata — **unchanged**)
- `text-neutral-800` (author name)
- `text-neutral-900` (comment body)
- `bg-yellow-50/40` (focused thread background — apply `dark:bg-amber-900/20` analogous to the table)
- `ring-yellow-200` (focused thread ring — apply `dark:ring-amber-800`)
- `border-yellow-300` (anchor preview left border)
- `border-neutral-300` + `bg-white` + `text-neutral-700` + `hover:bg-neutral-50` (Cancel buttons — 2 instances)
- `bg-neutral-900` + `text-white` + `hover:bg-neutral-800` (Save / Reply buttons — **unchanged**)

For the `ring-yellow-200` / `bg-yellow-50/40` focused-state pair, add `dark:bg-amber-900/20 dark:ring-amber-800` so the focused thread stays visible against the dark sidebar.

- [ ] **File 2 done.**

### File 3: `apps/web/src/components/NewThreadComposer.tsx`

Color classes present:
- `border-yellow-200` (composer outer border)
- `bg-yellow-50` (composer background)
- `text-amber-700` ("New comment" label)
- `border-yellow-300` (anchor preview left border)
- `text-neutral-600` (anchor preview italic)
- `border-neutral-300` + `bg-white` + `text-neutral-700` + `hover:bg-neutral-50` (Cancel button)
- `bg-neutral-900` + `text-white` + `hover:bg-neutral-800` (Comment button — **unchanged**)

- [ ] **File 3 done.**

### File 4: `apps/web/src/components/MentionTextarea.tsx`

Color classes present:
- `border-neutral-300` (default textarea border)
- `border-neutral-200` (popover border)
- `bg-white` (popover background)
- `bg-yellow-50` (highlighted typeahead item)
- `text-neutral-800` (user display name)
- `text-neutral-500` (user email)

- [ ] **File 4 done.**

### File 5: `apps/web/src/components/EditableField.tsx`

Color classes present:
- `text-neutral-400` (empty-state italic placeholder)
- `border-neutral-300` (active input/textarea border)
- `text-red-600` (error)

Note: the file has very few colors — most styling comes from `displayClassName` passed by callers.

- [ ] **File 5 done.**

- [ ] **Step: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: `Done`.

- [ ] **Step: Commit**

```bash
git add apps/web/src/components/CommentSidebar.tsx apps/web/src/components/ThreadCard.tsx apps/web/src/components/NewThreadComposer.tsx apps/web/src/components/MentionTextarea.tsx apps/web/src/components/EditableField.tsx
git commit -m "feat(web): dark variants for comment-family components"
```

---

## Task 5: Dark variants for chrome (5 files)

**Files:**

### File 1: `apps/web/src/components/UserMenu.tsx`

Color classes present:
- `text-neutral-700` (display name button)
- `hover:bg-neutral-100` (display name button hover)
- `border-neutral-200` (dropdown border)
- `bg-white` (dropdown background)
- `hover:bg-neutral-50` (sign-out item hover)

(All on the `text-neutral-700` line: `flex items-center gap-1.5 rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-100` — add `dark:text-neutral-300 dark:hover:bg-neutral-800`.)

- [ ] **File 1 done.**

### File 2: `apps/web/src/components/VersionSelector.tsx`

Color classes present:
- `border-neutral-300` (trigger button border)
- `bg-white` (trigger button + dropdown background)
- `text-neutral-700` (trigger button text + `v` font-mono)
- `hover:bg-neutral-50` (trigger button hover + dropdown row hover)
- `border-neutral-200` (dropdown border)
- `bg-yellow-50` (selected row highlight)
- `text-neutral-500` (version note + relative-time — **unchanged**)
- `text-neutral-400` ("no note" italic + timestamp)
- `bg-neutral-900` + `text-white` ("Latest" badge — **unchanged**, badge stays dark)

- [ ] **File 2 done.**

### File 3: `apps/web/src/components/AddVersionModal.tsx`

Color classes present:
- `bg-black/30` (modal scrim — **unchanged**)
- `bg-white` (modal panel)
- `border-neutral-200` (header divider, doc card border, search results border, footer divider)
- `bg-neutral-50` (preselected doc card background)
- `text-neutral-800` (doc title)
- `text-neutral-700` (label, dropdown item title)
- `text-neutral-500` (close X button, "← change document" link, metadata)
- `text-neutral-900` (header title, hover state for close button)
- `hover:text-neutral-900` (close button hover + "change document" hover)
- `bg-yellow-50` (selected doc in search results)
- `border-neutral-300` (text input border, file note input border, Cancel button border)
- `hover:bg-neutral-50` (search result hover, Cancel button hover)
- `bg-white` (Cancel button background) — already covered above
- `bg-neutral-900` + `text-white` + `hover:bg-neutral-800` (Add version button — **unchanged**)
- `text-red-600` (error)

- [ ] **File 3 done.**

### File 4: `apps/web/src/components/DocumentListRow.tsx`

Color classes present:
- `border-neutral-100` (row borders)
- `hover:bg-neutral-50` (row hover)
- `text-neutral-900` (doc title)
- `text-neutral-500` (description, timestamp, etc.)
- `text-neutral-400` ("no description" em)
- `bg-neutral-100` (thread-count pill background)
- `text-neutral-600` (thread-count pill text)
- `text-neutral-800` (deleted doc title)
- `bg-red-100` + `text-red-700` (urgent "days left" pill)
- `border-neutral-300` + `bg-white` + `text-neutral-700` + `hover:bg-neutral-50` (Restore button)

- [ ] **File 4 done.**

### File 5: `apps/web/src/components/FileDropZone.tsx`

The drop zone has three states (error, dragging, idle) with different colors. Each state's color classes need dark partners.

Color classes (per state):
- Error: `border-red-400 bg-red-50`
- Dragging: `border-yellow-500 bg-yellow-50` — **`border-yellow-500` is unchanged** (mid-tone, works on both), `bg-yellow-50` → `dark:bg-amber-900/20`
- Idle: `border-neutral-300 bg-neutral-50` → `dark:border-neutral-700 dark:bg-neutral-900`

Plus:
- `text-neutral-500` (upload-cloud icon + size hint — **unchanged**)
- `text-neutral-700` (main prompt text)
- `text-neutral-600` (file-icon stroke + Replace button base)
- `hover:text-neutral-900` (Replace button hover)
- `text-neutral-800` (selected file name)
- `text-red-600` (error message)

For the `borderClass` ternary at lines 75-79, replace the three branches to include `dark:` partners. The resulting expression should read approximately:

```ts
  const borderClass = error
    ? 'border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-900/20'
    : isDragging
      ? 'border-yellow-500 bg-yellow-50 dark:bg-amber-900/20'
      : 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900';
```

- [ ] **File 5 done.**

- [ ] **Step: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: `Done`.

- [ ] **Step: Commit**

```bash
git add apps/web/src/components/UserMenu.tsx apps/web/src/components/VersionSelector.tsx apps/web/src/components/AddVersionModal.tsx apps/web/src/components/DocumentListRow.tsx apps/web/src/components/FileDropZone.tsx
git commit -m "feat(web): dark variants for chrome components"
```

---

## Task 6: Final verification

**Files:** none modified — this is a verification + smoke task.

- [ ] **Step 1: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: all three projects `Done`.

- [ ] **Step 2: Workspace test suite**

Run: `pnpm -r test --run`
Expected: all suites pass (no regressions; we didn't change any logic).

- [ ] **Step 3: Workspace build**

Run: `pnpm -r build`
Expected: api + web both build cleanly. No warnings about missing variants.

- [ ] **Step 4: Coverage check via grep**

From the repo root, run:

```bash
rg -n '\bbg-white\b' apps/web/src
rg -n '\bbg-neutral-50\b' apps/web/src
rg -n '\bbg-neutral-100\b' apps/web/src
rg -n '\btext-neutral-900\b' apps/web/src
rg -n '\btext-neutral-700\b' apps/web/src
rg -n '\bborder-neutral-200\b' apps/web/src
rg -n '\bborder-neutral-300\b' apps/web/src
```

For each hit, the surrounding className string should also contain the matching `dark:` partner. The exceptions are: the selection pill in `document.tsx` (already dark) and the `ThemeToggle.tsx` base classes (already have dark partners). If you find a hit without a dark partner, add the partner per the mapping table, re-stage, and `git commit --amend` into the latest task's commit (or, if Task 6 already has a commit, add a separate fix commit).

- [ ] **Step 5: Manual smoke (deferred to controller / human in non-interactive subagent contexts)**

Start the dev environment and walk each route in three preferences. Verify the checklist from the spec:

1. Set preference to **Light**: navigate `/`, `/upload`, `/d/<some-doc>`, `/admin`, `/dev/harness`. Each page renders as before — no visible change.
2. Set preference to **Dark**: each page renders with the inverted palette. Confirm:
   - No invisible text (black-on-black or white-on-white).
   - Hover states distinguishable from base states (buttons, menu items, doc list rows).
   - Error banners (`/admin` mock, file dropzone with bad file) readable.
   - Yellow/amber surfaces (read-only banner, NewThreadComposer, focused ThreadCard) readable.
   - Modals (`AddVersionModal`), dropdowns (`UserMenu`, `VersionSelector`, `⋯` menu) themed correctly.
   - Skeleton loading cards on `/admin` visible.
   - The artifact iframe edge looks acceptable (light artifact inside dark chrome — accepted).
3. Set preference to **System**: confirm OS prefers-color-scheme drives the effective theme. Toggle OS theme; the page should re-theme without reload.

If the subagent context is non-interactive, report Step 5 as deferred — controller will run it.

- [ ] **Step 6: Final commit (if any fixes from Step 4)**

If Step 4 surfaced any missed `dark:` partners, commit them:

```bash
git add apps/web/...
git commit -m "fix(web): cover missed dark variants found in verification sweep"
```

If no fixes were needed, no commit. Plan complete.

---

## Self-review checklist (for the implementer)

| Spec section                                | Task(s)         |
|---------------------------------------------|-----------------|
| `@custom-variant dark (&:where(.dark, .dark *));` in index.css | Task 1 Step 1 |
| Pre-paint inline `<script>` in index.html   | Task 1 Step 2   |
| `dark:` body classes in index.html          | Task 1 Step 2   |
| `useTheme()` hook                           | Task 1 Step 3   |
| ThemeToggle button cycling light → dark → system | Task 2 Step 1 |
| Render ThemeToggle next to UserMenu         | Task 2 Step 2   |
| AppShell dark variants                      | Task 2 Step 2   |
| Routes: home, upload, document, admin, devHarness, notFound | Task 3 |
| Components: CommentSidebar, ThreadCard, NewThreadComposer, MentionTextarea, EditableField | Task 4 |
| Components: UserMenu, VersionSelector, AddVersionModal, DocumentListRow, FileDropZone | Task 5 |
| Manual eyeball verification                 | Task 6 Step 5   |
| `bg-neutral-900` primary buttons stay dark in both themes | Honored in every task's "unchanged" rows |
| `localStorage['primer.theme']` key          | Task 1 Step 3   |
| Default first-time preference: `'system'`   | Task 1 Step 3 (`readPreference` returns `'system'` when key absent) |

Type consistency: `Preference = 'light' | 'dark' | 'system'` and `Effective = 'light' | 'dark'` are defined in `useTheme.ts` (Task 1) and consumed in `ThemeToggle.tsx` (Task 2). The localStorage key string `'primer.theme'` is used in both the inline `<script>` (Task 1 Step 2) and the hook (Task 1 Step 3); they must match.
