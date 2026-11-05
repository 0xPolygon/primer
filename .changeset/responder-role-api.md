---
"@primer/api": minor
"@primer/web": minor
---

Adds a `responder` collaborator role that can read, comment and submit document events but cannot publish versions or rename; commenters can no longer submit events.

Commenters keep reading `collaborators`- and `artifact`-audience events. Events never grant or change permissions: roles change only through the collaborators API, by the document owner.
