---
"@primer/api": patch
---

Records, decisions and task titles that agents read are fenced as untrusted
data, by default: every key and string is fenced except a literal allowlist of
Primer's own field names and ids. That covers a record's data and a change's
before and after images (when anyone but the agent contributed to them) and
the writer's name, a choice's question, option labels, rationale, evidence
labels, open questions and the picker's and proposer's names (in the register
and in the tally's decision), and a task's title. Evidence links are kept only
when they are well-formed http(s) URLs. Record data keys are plain names,
refused at write otherwise. People read the same text plain.
