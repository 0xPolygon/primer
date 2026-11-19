---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": patch
"@polygonlabs/plugin-primer": minor
---

Data tables bound to shared records, live with charts, and frozen in checkpoints.

- **Data-table blocks.** A `dataTable` block is a view over one records collection of the document: typed columns (text, number, date, select), cells edited in place (each edit writes the record with the version it read), rows added and deleted, and comments on rows (`data-point` anchors: row = record id). Others' writes arrive through the coalesced `data.changed` and the table re-reads, so people and agents see each other's changes live. Insert one from the slash menu or with `primer_apply_ops` (`json` block). No formulas or relations.
- **Named warehouse queries.** Collections named `query:<name>` hold a query's results written by an agent (Primer runs no queries); tables show them read-only, and charts draw them like any collection.
- **Live charts.** A widget bound to a collection redraws on the same `data.changed` that refreshes the tables over it.
- **Checkpoints freeze records.** Bundles gain `records.json` (shared records at capture). Static renderings draw data tables from it, bound widgets are drawn from it too (so a checkpoint's table and chart agree), and record-reading pages in external shares and checkpoint views read it in the page, read-only, under the records outbound policy. Restore redraws bound widgets from the live records.
- **Fencing.** Agents read every string of records others wrote (and of bound widget rows) fenced as untrusted; storage and people see the plain values.
- api-types: `DataTableColumn`, `DataTableSpec`, `parseDataTable`, `recordCellText`, `RecordsSnapshot`, `QUERY_COLLECTION_PREFIX`, `MAX_DATA_TABLE_COLUMNS`, `MAX_DATA_TABLE_ROWS`, and `PageInfoResponse.frozen`.
