# PRD: Primer

**Author:** Taylan Pince
**Status:** Draft
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

From either the home page or an existing document's detail page, the user explicitly selects "Add version to existing document." A typeahead lets them pick from their own existing documents (only the document's original uploader can add versions — see open questions). They drop the new HTML and optionally add a version note ("fixed Y-axis scale," "added Q2 numbers"). The system creates a new version under the same document container. The document's canonical URL (`/d/{docId}`) now serves the latest version; previous versions remain accessible at version-specific URLs (`/d/{docId}/v/{versionNumber}`).

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

Anyone with access can reply to any thread. Anyone can resolve a thread (it dims the anchor marker and moves under a "resolved" filter). Anyone can reopen a resolved thread. Replies in a thread you participated in trigger a Slack DM to other thread participants who are not the new commenter.

Comment edits and deletes are restricted to the comment author. Edits are unlimited (with an "edited" indicator after the fact); deletes leave a tombstone ("deleted by author") so reply context isn't broken.

### Versions and old threads

When viewing the latest version of a document, you can drop new threads, reply, resolve, and reopen normally. When viewing an older version (any version that is not the latest), the document is in a read-mostly mode: you cannot drop new top-level threads, but you can reply to, resolve, and reopen existing threads anchored to that version. This preserves cross-version discussion continuity without confusing the surface area of "where do new conversations happen."

### Manage your documents

The user's home page shows two lists: **My documents** (everything they uploaded, sorted by most recent activity) and **Recently viewed or commented** (anything they opened or interacted with in the last N days). There is no global index, no cross-Polygon document feed, no search. Documents not in either list are reachable only by direct URL.

A document can be deleted only by its original uploader. Delete is soft-delete with a 30-day reversible window; after that, all versions, threads, comments, and storage objects are hard-purged.

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
sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
```

Notably *not* `allow-same-origin`. This prevents the iframe from accessing the parent's cookies, localStorage, or DOM. CSP on the iframe response permits inline scripts (most LLM artifacts use them) and explicitly allowlisted CDNs. Initial proposed allowlist: `cdn.tailwindcss.com`, `cdnjs.cloudflare.com`, `unpkg.com`, `cdn.jsdelivr.net`, `fonts.googleapis.com`, `fonts.gstatic.com`. Tightened or expanded as we see real usage.

### Companion script

A single signed script served from the app's domain at `/companion/v1.js` is injected by the upload pipeline immediately before the closing `</body>` tag of every uploaded HTML file. This is the **only** mutation the system makes to uploaded content. Its responsibilities:

1. Capture text selections (`selectionchange` event) and report them to the parent via `postMessage` with normalized anchor data (selected text + prefix + suffix + container path).
2. When the parent enters element-pick mode, capture the next clicked element and report its element path and inner-content hash.
3. Render in-iframe comment markers (highlights on text ranges, badges next to elements) based on anchor data the parent sends down via postMessage.
4. Resolve anchors on initial load: given anchors from the parent, find their current positions in the live DOM and report pixel coordinates back, used by the parent to align sidebar entries with their in-iframe positions.

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

All messages include a shared token established at iframe initialization to reject cross-document interference.

### Anchor resolution & drift handling

When a user makes a selection, the companion script generates an anchor with both text-range data (primary) and element-path data (for the containing element). On render, the script attempts text-range resolution first: find the unique occurrence of `prefix + selectorText + suffix` within the document. If that fails (text changed or duplicated), it falls back to element-path: locate the element by selector path and verify the inner-content hash. If that also fails, the anchor is marked "drifted" — the comment still appears in the sidebar with a small "this comment's location could not be determined" indicator, but no in-iframe marker.

Because anchors are bound to specific immutable versions, drift should be rare in practice. The fallback exists as a safety net for content that legitimately moves at render time (e.g., charts that animate into place).

### Notifications

When a comment is created, the API:

1. Parses @mentions from the body. For each mentioned user, enqueues a Slack DM job.
2. Looks up the parent thread. For each unique prior participant who is not the new commenter, enqueues a Slack DM job ("X replied to your thread on [document title]").
3. Each Slack message includes a deep link back to the document at the right version and thread.

Slack `user_id` lookup happens lazily on first sign-in by matching email against the Slack Web API.

## Authentication & Access

- Okta OIDC, restricted to the Polygon Okta org. Any signed-in user has read and comment access to every document.
- Sessions via signed cookies. CSRF protection on mutating endpoints.
- Only a document's original uploader can delete that document and can upload new versions to it.
- Comment edit and delete: only by the comment author. Thread resolve and reopen: anyone.

## Storage & Limits

- HTML file size: 10 MB hard limit per upload. Covers nearly all LLM artifacts including those with embedded base64 images.
- File type: a single `.html` file. No zip uploads, no folder uploads.
- Per-document version count: no enforced limit at launch; monitor and revisit.

## Open Questions

1. **HTML sanitization scope.** What, if anything, do we strip from uploaded HTML before serving? Options range from "nothing — iframe sandbox is the defense" to "strip nested `<iframe>` and `<form>` elements that could phish inside the sandbox" to "full DOMPurify pass." Recommendation: minimal stripping, lean on the sandbox. Add server-side scrubbing if specific abuses emerge.
2. **External resource allowlist.** Final CDN list for the iframe CSP. Proposal above is a starting point; we'll refine based on what real uploads need.
3. **Comment edit window.** Unlimited edits with "edited" indicator is the proposed default. Alternative is a short edit window (e.g., 5 minutes) to reduce post-hoc rewriting of contentious threads. Recommend unlimited unless someone has a strong objection.
4. **Canvas elements.** Text-range and element-path both struggle with `<canvas>` content. For v1, you can comment on a canvas element as a whole but not on regions within it. Flag as a known limitation in product copy.
5. **Comment sync model.** Polling interval for new comments and replies. Proposing 10s polling on the active document view, no WebSocket in v1.
6. **Version permissions.** Should only the document's original uploader be able to add new versions, or should anyone be able to (with the doc still belonging to the original uploader)? Proposing uploader-only for v1 to keep ownership clean.

## Rough Milestones

- **Week 1–2:** Auth (Okta), basic upload + storage, iframe rendering, no commenting yet.
- **Week 3–4:** Companion script, text-range anchoring, comment creation and display.
- **Week 5:** Threading, replies, resolve / reopen.
- **Week 6:** @mentions, Slack DM notifications, Okta-to-Slack user resolution.
- **Week 7:** Versioning UI — add new version, version selector, cross-version threads.
- **Week 8:** Element-path fallback anchoring, polish, internal alpha to a small group.

Total: roughly 8 weeks to a usable internal alpha. Aggressive but doable for a focused two-person build.
