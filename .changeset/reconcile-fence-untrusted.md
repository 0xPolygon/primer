---
"@primer/api": patch
---

Records, decisions and task titles that agents read are fenced as untrusted
data (`fenceUntrusted`): the strings in a record's data and a change's
before and after images (when anyone but the agent contributed to them), a
choice's question, option labels, rationale, evidence labels and open
questions (in the register and in the tally's decision), and a task's title.
People read the same text plain.
