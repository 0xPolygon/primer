---
title: "ADR 7: One apply pipeline"
status: accepted
date: 2026-11-19
tags: [live, pipeline]
---

# ADR 7: One apply pipeline

## Context

Every server write to a live document must keep comment marks it doesn't touch.

## Decision

All writes go through `applyPlan`:

| Writer | Origin | Preconditions |
|--------|--------|---------------|
| Agent ops | agent | block version |
| Restore | person | none |
| Import | system | none |

```ts
await applyPlan(documentId, origin, { edits, onConflict: 'refuse' });
```

## Consequences

Positive:
Undo is one inverse per edit.
Negative: a slow transform blocks the document's queue.
