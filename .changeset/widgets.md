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
- **Labels.** Each label's words live in the document (`widget/<blockId>/<textId>`). A republish keeps people's edits: unchanged labels carry them, and when the agent changed the same label the person's words stay and the agent is told.
- **Skill.** `widgets.md` (also the MCP resource `primer://skills/widgets`) teaches the house style and gives copyable flows, trees, 2×2s, timelines, funnels, roadmaps and bar, line and area charts.
- api-types: `WidgetDraftRequest`, `WidgetDraftResponse`, `WidgetPublishResponse`, `WidgetDTO`, `WidgetError`, `WidgetLabelOutcome`, and the refusal code `widget_invalid`.
- New dependencies: `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` (MIT), `acorn` and `acorn-jsx` (MIT), `@resvg/resvg-js` (MPL-2.0), `roboto-fontface` (Apache-2.0).
