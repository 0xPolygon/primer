---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Agents draw diagrams and charts (widgets) in live documents, and people edit their labels in place.

- **Widgets.** A widget is a `widget` block: an SVG drawing an agent writes as one JSX/SVG module (no imports, no fetch, no `style`, no `foreignObject`, colours from theme tokens only). Every typed label carries a literal `data-text-id`, named parts carry `data-anchor`, and marks drawn from rows carry `data-row`/`data-col`.
- **Safe rendering on the server.** Modules are validated (each error with its line and fix), run in QuickJS (WASM, 16 MB, 50 ms, 5,000 elements, no clock or random) and their output always passes a runtime SVG allowlist and bounds (512 KB, a 4096 viewBox). PNG previews come from resvg, drawn in Roboto, the face the page uses.
- **Draft, preview, publish.** `primer_widget_draft` returns light and dark PNG previews; `primer_widget_publish` publishes only that exact preview (`previewHash`); a draft with errors never replaces the live widget. `primer_widget_get` reads a widget with its labels as people see them. REST: `POST /api/documents/:docId/widgets/draft`, `POST /api/widgets/:widgetId/publish`, `GET /api/widgets/:widgetId`, `GET /api/widgets/:widgetId/image`.
- **In the editor.** A widget block draws its live SVG inline for the page's theme. People edit a label in place through the shared overlay (and comment on it there), and click a mark drawn from a row, or a named part, to comment on that data point or part; commented parts are marked and listed under the widget. The SVG is allowlisted on the server and checked again in the browser (one positive value grammar per attribute, shared in api-types as `isWidgetAttributeValue`) before it is mounted as nodes, never as markup.
- **Labels.** Each label's words live in the document (`widget/<blockId>/<textId>`), shaped like page text, so agents edit one with `primer_apply_ops` `update` by `{ tabId, blockId, textId }` and its version, and suggestions keep the `textId`. A republish keeps people's edits: unchanged labels carry them, and when the agent changed the same label the person's words stay and the agent is told.
- **Comments on parts and data points.** A `widget-part` or `data-point` thread is accepted only when the live publish draws that part, or has that row and column.
- **Records.** A draft can draw a records collection (`collection` instead of `rows`); the published widget redraws by itself on `data.changed`, keeping the last good publish if a redraw fails.
- **Checkpoints.** Bundles keep each widget as it looked (`widgets/<id>.light.svg`, `.dark.svg`, `.json`), static renderings and print draw them, restore republishes them, and purge deletes every file a bundle's manifest lists.
- An agent that may only suggest in a document doesn't draw there (a publish changes what people see at once). Comment listeners on a page share one event stream per document.
- **Skill.** `widgets.md` (also the MCP resource `primer://skills/widgets` on both MCP servers, linked from `authoring.md`) teaches the house style and gives copyable flows, trees, 2×2s, timelines, funnels, roadmaps and bar, line and area charts.
- api-types: `WidgetDraftRequest`, `WidgetDraftResponse`, `WidgetPublishResponse`, `WidgetDTO`, `WidgetLabelDTO`, `WidgetError`, `WidgetLabelOutcome`, `isWidgetAttributeValue`, and the refusal code `widget_invalid`.
- New dependencies: `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` (MIT), `acorn` and `acorn-jsx` (MIT), `@resvg/resvg-js` (MPL-2.0), `roboto-fontface` (Apache-2.0, in the API and the web app).
