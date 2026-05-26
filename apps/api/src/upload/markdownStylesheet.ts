/**
 * Inline stylesheet baked into Markdown-uploaded artifacts.
 *
 * Why inline (not served): the artifact iframe is sandbox="allow-scripts
 * allow-forms" (no allow-same-origin) and CSP `connect-src 'none'`, so an
 * external stylesheet would require widening CSP. Inline <style> is already
 * permitted via `style-src 'unsafe-inline'`. The file is small enough that
 * inlining is cheaper than the cross-origin plumbing.
 *
 * Theming: CSS variables under :root and [data-theme="dark"]. The companion
 * script sets `document.documentElement.dataset.theme` from a parent
 * postMessage; without the companion, the document stays light.
 */
export const MARKDOWN_STYLESHEET = `
:root, html[data-theme="light"] {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --code-bg: #f3f4f6;
  --link: #2563eb;
}
html[data-theme="dark"] {
  --bg: #0a0a0a;
  --fg: #e5e7eb;
  --muted: #9ca3af;
  --border: #374151;
  --code-bg: #1f2937;
  --link: #60a5fa;
}

html, body {
  background: var(--bg);
  color: var(--fg);
  margin: 0;
}
body {
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.primer-md {
  max-width: 760px;
  margin: 0 auto;
  padding: 48px 24px;
}
.primer-md h1, .primer-md h2, .primer-md h3, .primer-md h4, .primer-md h5, .primer-md h6 {
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
  font-weight: 600;
}
.primer-md h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.primer-md h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.primer-md h3 { font-size: 1.25em; }
.primer-md h4 { font-size: 1em; }
.primer-md h5 { font-size: 0.9em; color: var(--muted); }
.primer-md h6 { font-size: 0.85em; color: var(--muted); }
.primer-md p { margin: 0 0 1em; }
.primer-md a { color: var(--link); text-decoration: none; }
.primer-md a:hover { text-decoration: underline; }
.primer-md ul, .primer-md ol { margin: 0 0 1em; padding-left: 1.5em; }
.primer-md li { margin: 0.25em 0; }
.primer-md li > p { margin: 0.25em 0; }
.primer-md blockquote {
  margin: 0 0 1em;
  padding: 0 1em;
  border-left: 4px solid var(--border);
  color: var(--muted);
}
.primer-md hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 2em 0;
}
.primer-md code {
  font: 0.9em/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--code-bg);
  padding: 0.1em 0.35em;
  border-radius: 3px;
}
.primer-md pre {
  background: var(--code-bg);
  padding: 1em;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0 0 1em;
}
.primer-md pre > code {
  background: transparent;
  padding: 0;
  font-size: 0.9em;
  line-height: 1.5;
}
.primer-md table {
  border-collapse: collapse;
  margin: 0 0 1em;
  width: 100%;
}
.primer-md th, .primer-md td {
  border: 1px solid var(--border);
  padding: 0.4em 0.7em;
  text-align: left;
}
.primer-md th { background: var(--code-bg); font-weight: 600; }
.primer-md img { max-width: 100%; height: auto; }
.primer-md del { color: var(--muted); }
.primer-md input[type="checkbox"] {
  margin-right: 0.4em;
  vertical-align: middle;
}
.primer-md ul.contains-task-list { padding-left: 0; list-style: none; }
.primer-md .task-list-item { padding-left: 0; }
`.trim();
