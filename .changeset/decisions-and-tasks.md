---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Choice blocks with a decision register, task blocks that become tracked tasks, and mention notifications.

- **Choice blocks.** A choice is a layout block of option blocks: people vote
  live (one vote each, shared records in `primer.choice/<blockId>` that only
  the vote route writes), comment on options, and one person with edit rights
  decides with a rationale, evidence and open questions
  (`POST /api/documents/:docId/choices/:blockId/vote|pick`,
  `DELETE …/decision` to clear). Agents lay out choices
  (`primer_add_choice`) and propose picks (`primer_propose_pick`), never make
  or clear one. A pick emits `primer.decision.made`; clearing emits
  `primer.decision.cleared`.
- **Decision register.** `GET /api/documents/:docId/decisions` and
  `primer_list_decisions`: a projection over the choice blocks joined with
  the recorded decisions (`doc_decisions`, tied to the block by a
  server-minted nonce), showing the question and label as decided and
  flagging later edits. A Decisions panel in the editor shows it. Exports and
  static renders take the decision from the record, never the document.
- **Task blocks.** A checklist item with an assignee (person or agent), due
  date and status. `doc_tasks` is a rebuildable index kept from the document;
  changes emit `primer.task.created`, `primer.task.updated` and
  `primer.task.deleted`, attributed per block. Ticking the box closes the
  task; the assignee reports progress inline (`primer_update_task`).
  `GET /api/tasks?assignee=me`, `GET /api/documents/:docId/tasks`,
  `primer_add_task`, `primer_list_tasks`.
- **Mentions.** A mention chip notifies the person it names, once.
- Agent reads of decisions and tasks are marked `untrusted`.
