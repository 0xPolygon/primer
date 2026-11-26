---
"@primer/api": patch
---

Widgets: reference expansion is capped (drawings whose `<use>` and `url(#…)` references, such as nested patterns, expand past 2,000 instances are refused), rendered PNGs are cached by drawing, each render runs in a child process that is killed after 10 s (the draft or image is refused as too costly to draw), at most two render at once across the process, and draft and PNG requests are rate limited. A checkpoint from before a widget's first publication counts as a widget change for suggest-only agents. Only editors see a widget's draft.
