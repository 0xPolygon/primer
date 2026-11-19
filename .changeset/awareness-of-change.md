---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Awareness of change: catch-up, a digest, change highlights, fuzzy re-anchoring, citations and promoting conversations.

- **Catch-up.** Opening a document returns the viewer's previous visit
  (`lastView`; `document_views.last_doc_version`). `GET
  /api/documents/:docId/catchup?since=&sinceVersion=` lists what others did
  since, per person: changed blocks (as they read now), threads started,
  replied to and resolved, decisions, suggestions, tasks and versions. A
  dismissible "Since you last looked" panel shows it and highlights the
  changed blocks.
- **Digest.** `GET /api/me/digest?since=` and `primer_get_digest`: the
  catch-up of every document in the caller's library that changed, each one
  re-checked for read access. AidenHQ pushes it to Slack or Telegram; Primer
  emails it only on request (`POST /api/me/digest/email`), rendered by
  `exportHtml`.
- **Highlights since the last checkpoint.** A header toggle; checkpoints in
  the version list carry their `docVersion`.
- **Fuzzy re-anchoring.** `primer_reanchor_thread` and a Re-anchor button on
  orphaned threads match the quote exactly, then reworded (≥ 80% alike, one
  bounded similarity, ties refused). Never automatic; legacy carry stays exact.
- **Citations.** A `citation` inline chip (url, or a Primer document pinned
  to the cited version) numbered in reading order;
  `GET /api/documents/:docId/citations`.
- **Promote a conversation.** `primer_promote_conversation`, `POST
  /api/documents/from-conversation` and "Promote to document" on a thread:
  one quote block per message, text kept literal.
- Comment marks no longer count as edits in delta reads, and text edited
  inside a page counts as a change to its page block; agents' ops can't
  write a choice's decision props.
- The "Add version" dialog shows the suggestions a republish made when it
  made no version.
