---
"@primer/api": patch
---

Fix a remote code execution in Markdown uploads. gray-matter selected its parse
engine from the front-matter fence language and its built-in JavaScript engine
ran the block through `eval()`, so an uploaded `.md` beginning with `---js`
executed arbitrary code with the API process's privileges at upload time.
Markdown front-matter is now parsed with the JavaScript engine disabled; YAML
and JSON front-matter are unchanged.
