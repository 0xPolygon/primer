# Primer Dark Mode — Design

**Date:** 2026-05-21
**Status:** Approved

## Goal

Add dark mode to the Primer web app. Users get a three-state preference (light / dark / system) accessible via a single header icon, persisted to localStorage, defaulting to "system" so first-time visitors automatically match their OS.

## Non-goals

- Theming the contents of the artifact iframe (user-uploaded HTML brings its own styles).
- Re-tuning the companion script's highlight overlay (already RGBA-balanced to work on any artifact background).
- A token / semantic-color abstraction layer. Inline `dark:` variants are sufficient for an app this size.
- Server-side persistence of the theme preference. localStorage is fine — preference is per-browser, per-device, not per-user.
- Automated dark-mode tests. Would only assert class-string presence; manual eyeball verification gives the real signal.

## Architecture

```
<html>           ← `.dark` class toggled by useTheme()
  <body>
    AppShell
      <header>
        Primer logo
        <ThemeToggle> ──┐
        <UserMenu>      │
      </header>         │
      <Outlet />        │
                        │
                        ▼
                     useTheme() hook
                        │
                        ├─ reads localStorage['primer.theme']  (light | dark | system)
                        ├─ watches matchMedia('(prefers-color-scheme: dark)')
                        ├─ computes effective theme
                        └─ toggles `.dark` class on document.documentElement
```

Tailwind v4 default `dark:` variant uses `prefers-color-scheme`. We override it to "class is `.dark` somewhere in the ancestor chain or on self" so the JS toggle drives styling:

```css
@import 'tailwindcss';
@custom-variant dark (&:where(.dark, .dark *));
```

That single line is the entire CSS config change.

## Components

### `apps/web/src/lib/useTheme.ts` (new)

Exports a `useTheme()` hook returning `{ preference, effective, setPreference }`:

```ts
type Preference = 'light' | 'dark' | 'system';
type Effective = 'light' | 'dark';
interface UseTheme {
  preference: Preference;
  effective: Effective;
  setPreference: (p: Preference) => void;
}
```

Responsibilities:

- Read `localStorage['primer.theme']` on mount; fall back to `'system'`.
- Resolve effective theme: if `preference === 'system'`, use `matchMedia('(prefers-color-scheme: dark)').matches`; otherwise echo the preference.
- Toggle `.dark` class on `document.documentElement` whenever effective changes.
- Subscribe to `matchMedia` changes; re-resolve when OS preference flips and the user's preference is `'system'`.
- On `setPreference`, write to localStorage and re-resolve.

Pre-React paint: a tiny inline script in `index.html` reads the same localStorage key and applies the `.dark` class synchronously before the bundle loads. Prevents flash-of-light-theme for users in dark mode. (Standard pattern; ~5 lines.)

### `apps/web/src/components/ThemeToggle.tsx` (new)

A single `<button>` rendered in the AppShell header, immediately to the left of `<UserMenu>`. Click cycles `light → dark → system → light`. Icon reflects current `preference`:

- `light` → sun
- `dark` → moon
- `system` → laptop/monitor (or half-sun-half-moon)

Inline SVGs matching the existing icon style used in the Export button (`document.tsx`). `aria-label` reflects current preference and what clicking will do next ("Theme: Light — click for Dark").

### `apps/web/src/AppShell.tsx` (modified)

- Calls `useTheme()` at the top so the hook is always active (drives the `.dark` class).
- Renders `<ThemeToggle>` immediately before `<UserMenu>` inside the existing header flex.
- Add `dark:` variants to the header and main container.

### `apps/web/src/index.css` (modified)

Two lines total:

```css
@import 'tailwindcss';
@custom-variant dark (&:where(.dark, .dark *));
```

### `apps/web/index.html` (modified)

Inline `<script>` in `<head>` that synchronously reads localStorage and applies `.dark` to `<html>` before paint. Approximate content:

```html
<script>
  (function () {
    try {
      var p = localStorage.getItem('primer.theme') || 'system';
      var dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      if (dark) document.documentElement.classList.add('dark');
    } catch (_) { /* localStorage may be unavailable */ }
  })();
</script>
```

### `apps/web/src/**/*.tsx` (modified — ~14 files)

Sprinkle `dark:` variants throughout. Standard mapping (see Color mapping section).

## Color mapping

Single canonical mapping applied across every touched component:

| Light class                          | Dark variant                              | Notes |
|--------------------------------------|-------------------------------------------|-------|
| `bg-white`                           | `dark:bg-neutral-900`                     | Primary surface |
| `bg-neutral-50`                      | `dark:bg-neutral-900`                     | Collapsed with `bg-white` in dark — light's subtle 50/white hierarchy isn't load-bearing |
| `bg-neutral-100` (hover)             | `dark:bg-neutral-800`                     | Hover/active states |
| `bg-neutral-200` (skeleton)          | `dark:bg-neutral-700`                     | Loading skeletons |
| `bg-neutral-900` (primary button)    | (unchanged — stays dark)                  | Primary actions read as primary in both themes |
| `bg-neutral-800` (button hover)      | (unchanged)                               |       |
| `text-neutral-900`                   | `dark:text-neutral-100`                   | Body text |
| `text-neutral-800`                   | `dark:text-neutral-200`                   |       |
| `text-neutral-700`                   | `dark:text-neutral-300`                   |       |
| `text-neutral-600`                   | `dark:text-neutral-400`                   | Subdued text |
| `text-neutral-500`                   | `dark:text-neutral-500`                   | Already mid-tone, leave as-is |
| `text-neutral-400`                   | `dark:text-neutral-500`                   | Disabled / placeholder |
| `text-white` (on dark buttons)       | (unchanged)                               |       |
| `border-neutral-200`                 | `dark:border-neutral-800`                 |       |
| `border-neutral-300`                 | `dark:border-neutral-700`                 |       |
| `bg-yellow-50` + `text-amber-900` (read-only banner) | `dark:bg-amber-900/20` + `dark:text-amber-200` | Translucent amber on dark |
| `border-yellow-200`                  | `dark:border-amber-800`                   |       |
| `bg-red-50` + `text-red-700` / `red-600` (errors) | `dark:bg-red-900/20` + `dark:text-red-300` | Translucent red on dark |
| `border-red-200`                     | `dark:border-red-800`                     |       |

This is the only place these substitutions are decided. Implementation should reference this table.

## Toggle behavior

| Current preference | Click → | New preference | Effective (light OS) | Effective (dark OS) |
|--------------------|---------|----------------|----------------------|---------------------|
| light              | →       | dark           | dark                 | dark                |
| dark               | →       | system         | light                | dark                |
| system             | →       | light          | light                | light               |

Three-click loop. The "system" stop in the cycle is what makes the OS-following mode discoverable — users who never click past `dark` still get manual override; users who click once more learn they can defer to OS.

## Scope boundary

- **In scope:** AppShell, header, all routes (`home.tsx`, `upload.tsx`, `document.tsx`, `admin.tsx`, `devHarness.tsx`, `notFound.tsx`), all shared components (`CommentSidebar.tsx`, `ThreadCard.tsx`, `EditableField.tsx`, `NewThreadComposer.tsx`, `MentionTextarea.tsx`, `AddVersionModal.tsx`, `VersionSelector.tsx`, `UserMenu.tsx`, `DocumentListRow.tsx`, `FileDropZone.tsx`, `ArtifactIframe.tsx` wrapper).
- **Out of scope:** artifact iframe contents, companion overlay CSS.
- **Visual seam:** when chrome is dark and the artifact is a light HTML doc, the iframe edge has a contrast jump. Accepted — artifacts look like documents and that's by design.

## Defaults

- **First-time visitor:** preference = `'system'`. Effective theme follows OS.
- **localStorage key:** `primer.theme`. Values: `'light' | 'dark' | 'system'`. Anything else is treated as `'system'`.
- **Primary buttons** (`bg-neutral-900`) stay dark in both themes — high contrast in both, consistent brand affordance.

## Testing

Manual. After implementation, walk each route in all three preferences (light, dark, system on light OS, system on dark OS) and verify:

1. No invisible text (`text-neutral-900` on a `bg-neutral-900` etc.).
2. Hover states distinguishable from base states.
3. Error/warning banners (red, amber) still readable.
4. Form inputs (textarea, file drop zone) visible and usable.
5. Modals (AddVersionModal) and dropdowns (UserMenu, ⋯ menu) themed.
6. Skeleton loading cards on `/admin` still visible.
7. The artifact iframe edge looks acceptable when chrome and content are different themes.

No automated tests. Class-string assertions would be brittle and wouldn't catch the actual failure modes (contrast, hierarchy, hover discoverability).

## Risks

- **Missed `dark:` variants in some component.** Mitigation: enumerated file list above; reviewer should verify every modified file actually got dark variants on its color classes.
- **Flash of wrong theme on cold load.** Mitigated by the inline `<script>` in `index.html`.
- **`prefers-color-scheme` changes mid-session.** Hook subscribes to the media query — covered.
- **localStorage unavailable** (e.g., private mode quirks). Hook falls back to `'system'` and the inline script silently no-ops; behavior degrades to OS-following.

## What gets committed

1. `apps/web/src/lib/useTheme.ts` — new
2. `apps/web/src/components/ThemeToggle.tsx` — new
3. `apps/web/src/index.css` — `@custom-variant` line
4. `apps/web/index.html` — inline pre-React theme script
5. `apps/web/src/AppShell.tsx` — wire hook + toggle, add dark variants
6. `apps/web/src/routes/*.tsx` — six route files
7. `apps/web/src/components/*.tsx` — ~ten component files
8. Optional: a short comment in `index.css` documenting the `@custom-variant` choice

The implementation plan should likely group the dark-variant sprinkles into a couple of commits (e.g., "AppShell + routes" then "components") rather than a single monster commit, so each commit stays reviewable.
