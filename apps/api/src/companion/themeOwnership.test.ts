// @vitest-environment jsdom
//
// The companion (v1.js) is served verbatim into the artifact iframe and is not
// importable, so — following the same convention as textRangeResolution.test.ts
// — the decision table below MIRRORS the theme-ownership guard in v1.js. If you
// change `primerOwnsTheme` / `applyParentTheme` in v1.js, mirror it here (and
// vice versa). The source-tie test at the bottom fails loudly if the guard is
// ever removed from the real file.
//
// Why the guard exists: only artifacts Primer authored (Markdown, marked by the
// upload pipeline with data-primer-theme="managed" on <html>) hand theme
// control to the parent app. Self-themed HTML artifacts drive their own
// data-theme via an in-artifact toggle; overwriting it desyncs that toggle from
// what's displayed — the light/dark flip bug this fixes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

// ── Mirror of v1.js ──────────────────────────────────────────────────
function primerOwnsTheme(): boolean {
  try {
    return document.documentElement.dataset.primerTheme === 'managed';
  } catch {
    return false;
  }
}

function applyParentTheme(theme: unknown): boolean {
  if (!primerOwnsTheme()) return false;
  if (theme !== 'light' && theme !== 'dark') return false;
  try {
    document.documentElement.dataset.theme = theme;
  } catch {
    /* defensive */
  }
  return true;
}

describe('companion theme-ownership guard (mirror of v1.js)', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-primer-theme');
    document.documentElement.removeAttribute('data-theme');
  });

  it('applies the parent theme when the artifact is Primer-managed', () => {
    document.documentElement.dataset.primerTheme = 'managed';
    expect(applyParentTheme('dark')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('leaves data-theme untouched when the artifact is not managed', () => {
    // Simulate a self-themed HTML artifact that set its own theme.
    document.documentElement.dataset.theme = 'light';
    expect(applyParentTheme('dark')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('does nothing when managed but the theme value is invalid', () => {
    document.documentElement.dataset.primerTheme = 'managed';
    expect(applyParentTheme('sepia')).toBe(false);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe('companion source-tie (guards the real v1.js)', () => {
  // process.cwd() is the apps/api package root under vitest. Avoids
  // import.meta.url, which the jsdom environment reports as a non-file URL.
  const src = readFileSync(join(process.cwd(), 'src/companion/v1.js'), 'utf8');

  it('gates theme application on the data-primer-theme="managed" marker', () => {
    expect(src).toContain("dataset.primerTheme === 'managed'");
  });

  it('routes both init and theme_changed through applyParentTheme', () => {
    // Two call sites: the init handler and the theme_changed port message.
    expect(src.match(/applyParentTheme\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('no longer writes dataset.theme unconditionally outside the guard', () => {
    // The only assignments to dataset.theme must live inside applyParentTheme.
    // Negative lookahead excludes the `=== 'dark'` comparison in pickMermaidTheme.
    const assignments =
      src.match(/documentElement\.dataset\.theme\s*=(?!=)/g) ?? [];
    expect(assignments.length).toBe(1);
  });
});
