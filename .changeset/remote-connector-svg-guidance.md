---
"@polygonlabs/plugin-primer": patch
---

Skill guidance: steer the remote HTTP connector away from large inline SVG. The `primer` skill now carves out the remote-connector case in "Diagrams and inline SVG" — on the HTTP connector there is no `contentPath`, so the model is the sole transport and every inlined byte is an output-token cost paid on every version. Large diagrams are pointed at data-driven rendering or hosted-asset URLs instead of inlining; local stdio server guidance (inline freely, `contentPath` keeps the body out of context) is unchanged.
