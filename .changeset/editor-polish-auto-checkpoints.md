---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
---

Live documents save checkpoints on their own: two minutes after edits settle,
and at least every ten minutes while editing goes on, only when someone changed
the content since the latest checkpoint. History marks them as automatic.
Saving a checkpoint by hand shows that it is saving, then "Checkpoint vN saved"
with a link to it, or says nothing changed since vN, or that it failed.

People can suggest instead of edit: the editor header has an Editing |
Suggesting switch. While suggesting, edits are a draft sent as suggestions
(apply ops with `mode: 'suggest'`), which the owner and editors accept or
reject. Commenters can suggest too.

The editor's toolbars, menus, comment popovers and side panels follow Primer's
light and dark tokens: the BlockNote Ariakit theme's own bevelled buttons,
nested toolbar frames and blue focus rings are replaced at the theme layer.
