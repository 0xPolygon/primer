---
"@primer/api": minor
"@primer/web": minor
---

Adds a `responder` collaborator role that can read, comment and submit document events but cannot publish versions or rename; commenters can no longer submit events.

Commenters keep reading `collaborators`- and `artifact`-audience events. Events never grant or change permissions: roles change only through the collaborators API, by the document owner.

Event namespace validation messages now use a neutral example namespace (`example`, `example/telemetry`, `example/*`) in their hints.

On a document page, a viewer whose role cannot write events (a commenter, or an org reader who is not a collaborator) is no longer asked to consent to a submission the server would refuse: the page answers the document's request with "You can view this document but can't respond to it."
