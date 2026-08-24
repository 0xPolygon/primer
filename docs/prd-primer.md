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
  companion forwards it over the MessagePort **only from within the same
  trusted event dispatch that carried a user gesture**, consuming the
  activation (one gesture = one submission). Checking
  `navigator.userActivation.isActive` alone is explicitly NOT sufficient — a
  malicious artifact could defer its dispatch into the activation window of
  an unrelated click, degrading "the reviewer tapped Send" to "the reviewer
  tapped anything" (silent injection into a consumer's work queue under the
  viewer's name). An artifact is untrusted code running in every viewer's
  browser, regardless of what produced it. The parent page remains the sole
  authed principal: it re-validates the batch and POSTs it; the server
  validates again and stamps the authenticated user as the row author —
  attribution can never be asserted from inside the iframe. Writes require
  the caller to be a document collaborator (owner included); external-share
  and public viewers cannot authenticate to these routes at all.

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
