---
"@primer/api": minor
"@primer/web": minor
---

Live documents have tabs. Editors add, rename (double-click) and delete tabs
above the editor; each tab is its own BlockNote editor over its own part of
the document, opened when the tab is. Exports and checkpoints include every
tab in order, later tabs under a `# <title>` heading (Markdown) or their
title (text and HTML). Restoring a checkpoint restores its tab list too.
Deleting a tab keeps its content in the document's history, unreachable: its
comment threads stay listed, without an anchor.
