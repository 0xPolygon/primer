/**
 * The single public home of Primer's REST API wire contract: every
 * request/response DTO shape used by apps/api's routes, the anchor shapes
 * stored in `threads.anchor` and returned by the threads endpoints, and the
 * two runtime validators used to check untrusted anchor payloads at the
 * edges of the system. Consumers: apps/api (routes, MCP tool bridge),
 * apps/mcp (comment formatting), and apps/web (transitively, via the
 * parent-side companion protocol module).
 */

// ───────────────────── Anchor shapes (wire contract) ─────────────────────
// Moved from packages/shared/src/companion-protocol.ts. These are stored in
// threads.anchor and returned by the threads endpoints, so they live here
// alongside the DTOs that reference them rather than with the companion
// postMessage envelope machinery (which stays app-local; see
// apps/web/src/companion/protocol.ts).

/** Text-range anchor. New captures (v1.1+) emit `start`/`end` raw
 *  character offsets into the artifact's flattened text. Legacy
 *  captures (pre-v1.1) carry `prefix`/`suffix`/`containerPath` for
 *  text-pattern resolution. The companion's resolver dispatches on
 *  which fields are present, so both shapes are valid on the wire and
 *  in storage. New code should write the position-based shape. */
export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  /** Inclusive raw cumulative character offset (position-based shape). */
  start?: number;
  /** Exclusive raw cumulative character offset (position-based shape). */
  end?: number;
  /** Legacy: text-context prefix. Present on pre-v1.1 anchors. */
  prefix?: string;
  /** Legacy: text-context suffix. Present on pre-v1.1 anchors. */
  suffix?: string;
  /** Legacy: CSS path to the nearest block ancestor. Present on
   *  pre-v1.1 anchors. */
  containerPath?: string;
}

export interface ElementPathAnchor {
  type: 'element-path';
  path: string;
  innerHash: string;
  /** Captured text content of the picked element at the moment it was picked.
   * Used for human-readable previews in the comment sidebar. Optional for
   * backward-compat with rows created before this field existed. */
  innerText?: string;
}

export type AnchorData = TextRangeAnchor | ElementPathAnchor;

// Live-document anchors (C6). A `prose` anchor's live position is BlockNote's
// `comment` mark in the fragment its target names (tab text, page text, a
// widget label), so one kind covers all marked text; `quote` keeps the text
// for when the mark is gone. The others stay structured.
export interface ProseAnchor {
  type: 'prose';
  target: Target;
  quote: string;
}

export interface WidgetPartAnchor {
  type: 'widget-part';
  target: Target;
  anchor: string;
}

export interface DataPointAnchor {
  type: 'data-point';
  target: Target;
  row: string;
  column: string;
}

export interface BlockAnchor {
  type: 'block';
  target: Target;
}

export type LiveAnchor = ProseAnchor | WidgetPartAnchor | DataPointAnchor | BlockAnchor;

/** Every anchor a thread can carry: legacy version anchors and live ones. */
export type ThreadAnchor = AnchorData | LiveAnchor;

// ───────────────────── Validation helpers ─────────────────────
// Moved from packages/shared/src/companion-protocol.ts, along with the
// private helpers they depend on. Dependency-free — the package's only
// runtime exports.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
  if (!isObject(v) || v.type !== 'text-range' || !isString(v.selectorText)) {
    return false;
  }
  // Position-based shape: start AND end must be finite numbers AND end > start.
  // (A zero-length range would resolve to an invisible "ghost" highlight.)
  const hasPosition =
    isNumber(v.start) && isNumber(v.end) && (v.end as number) > (v.start as number);
  // Legacy shape: prefix AND suffix AND containerPath must all be strings.
  const hasLegacy =
    isString(v.prefix) && isString(v.suffix) && isString(v.containerPath);
  return hasPosition || hasLegacy;
}

export function isElementPathAnchor(v: unknown): v is ElementPathAnchor {
  return (
    isObject(v) &&
    v.type === 'element-path' &&
    isString(v.path) &&
    isString(v.innerHash)
  );
}

const TARGET_SUBS = ['pid', 'textId', 'embedId'] as const;

export function isTarget(v: unknown): v is Target {
  if (!isObject(v) || !isString(v.tabId) || v.tabId === '' || !isString(v.blockId)) return false;
  let subs = 0;
  for (const key of TARGET_SUBS) {
    if (v[key] === undefined) continue;
    if (!isString(v[key]) || v[key] === '') return false;
    subs++;
  }
  return subs <= 1;
}

export function isLiveAnchor(v: unknown): v is LiveAnchor {
  if (!isObject(v) || !isTarget(v.target)) return false;
  switch (v.type) {
    case 'prose':
      return isString(v.quote) && v.quote.length > 0;
    case 'widget-part':
      return isString(v.anchor) && v.anchor.length > 0;
    case 'data-point':
      return isString(v.row) && isString(v.column);
    case 'block':
      return v.target.blockId !== '';
    default:
      return false;
  }
}

/** The text a thread is about, for labels: the quote, the picked element's
 *  text (or its path), or '' for structured live anchors. */
export function anchorLabel(anchor: ThreadAnchor): string {
  switch (anchor.type) {
    case 'text-range':
      return anchor.selectorText;
    case 'element-path':
      return anchor.innerText && anchor.innerText.length > 0 ? anchor.innerText : anchor.path;
    case 'prose':
      return anchor.quote;
    default:
      return '';
  }
}

/** Validates any thread anchor, legacy or live. */
export function isValidAnchor(v: unknown): v is ThreadAnchor {
  return isTextRangeAnchor(v) || isElementPathAnchor(v) || isLiveAnchor(v);
}

// ───────────────────── REST API DTOs ─────────────────────
// Moved verbatim from packages/shared/src/api.ts. AnchorData is now local
// (above) instead of imported from the companion-protocol module.

export interface UploadResponse {
  documentId: string;
  versionId: string;
  url: string;
}

export type UploadErrorCode =
  | 'validation_failed'
  | 'parse_failed'
  | 'too_large'
  | 'bad_extension'
  | 'bad_content_type'
  | 'missing_title'
  | 'missing_file'
  | 'internal';

export interface UploadErrorResponse {
  error: UploadErrorCode;
  message: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;             // NEW in SP5
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  createdAt: string;          // ISO timestamp
}

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
}

/** A person signs in; an agent acts through tokens, via a person. */
export type ActorKind = 'person' | 'agent';

export interface MeResponse extends UserDTO {
  isAdmin: boolean;
  kind: ActorKind;
  /** The person an agent acts via; null for people. */
  viaUserId: string | null;
}

/** One of the caller's agents (GET /api/agents). */
export interface AgentDTO {
  id: string;
  displayName: string;
  createdAt: string;
  tokens: ApiTokenSummary[];
}

export interface AgentsListResponse {
  agents: AgentDTO[];
}

export interface CreateAgentRequest {
  displayName: string;
}

export interface CreateAgentResponse {
  id: string;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;          // ISO timestamp
}

export interface DocumentDetail extends DocumentSummary {
  externallyShared: boolean;
  /** Set for live documents (edited in place, with checkpoints); null for
   *  legacy documents, which are version-only HTML. */
  format: DocumentFormat | null;
  /** Who may write on a live document as an agent (owner setting). */
  agentMode?: AgentMode;
}

/** The requesting viewer's effective role on a document. Mirrors
 *  EffectiveRole in apps/api/src/lib/permissions.ts: 'stranger' is a
 *  non-collaborator (readable only when visibility is 'org').
 *
 *  The ladder is commenter < responder < editor < owner; each step adds one
 *  kind of power. A commenter reads and comments. A responder additionally
 *  writes structured document events (so the page can act in their name) but
 *  cannot publish versions, rename, or manage people. An editor can also
 *  rewrite the document; only the owner manages collaborators. */
export type ViewerRole = 'owner' | 'editor' | 'responder' | 'commenter' | 'stranger';

export interface DocumentDetailResponse {
  document: DocumentDetail;
  latestVersion: VersionSummary;
  myRole: ViewerRole;
}

export interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  /** For an agent, already labelled "<name> (via <person>)" by the server,
   *  as every display name of an actor is. */
  authorDisplayName: string;
  authorKind: ActorKind;
  /** Display name of the person an agent author acts via; null for people. */
  authorVia: string | null;
  /** Empty string for a tombstoned comment — the server never discloses the
   *  text of a deleted comment, even to its author. The row keeps it, so an
   *  in-window restore brings the original text back. */
  body: string;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
  mentions: string[];
  /** Emoji reactions, each with the ids of the people who reacted. */
  reactions: CommentReaction[];
}

export interface CommentReaction {
  emoji: string;
  userIds: string[];
}

/** How long after deleting a comment its author may still undo the delete.
 *  Enforced by POST /api/comments/:id/restore; the web UI shows the Undo
 *  affordance for exactly this window so client and server agree. */
export const COMMENT_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** A comment thread. Threads belong to the document: a thread started on one
 *  version is carried to each later version while it is open (see
 *  `contextChanged`). */
export interface ThreadDTO {
  id: string;
  /** The version the thread was started on; null for a thread on a live
   *  document, which belongs to the live content. */
  versionId: string | null;
  versionNumber: number | null;
  /** Where the thread sits on the version that was listed. When
   *  `contextChanged` is true, or in single-thread responses, this is the
   *  anchor the thread was started with. */
  anchor: ThreadAnchor;
  /** True when the thread's quoted text could not be found on the listed
   *  version: it shows there without a highlight. */
  contextChanged: boolean;
  /** A live thread whose commented text was removed ("Text removed"). It
   *  stays open with its quote and can be re-anchored. */
  orphaned: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: string;
  comments: CommentDTO[];
}

export interface ThreadsListResponse {
  threads: ThreadDTO[];
  asOf: string;
}

export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
  mentions?: string[];
}

/** A selection in a live document: base64-encoded Yjs relative positions
 *  (`Y.encodeRelativePosition`) in the target's fragment. */
export interface RelativeSelection {
  anchor: string;
  head: string;
}

/** POST /api/documents/:docId/threads: a thread on a live document. A
 *  `prose` anchor's comment mark is placed by the server over `selection`,
 *  or else over the first occurrence of the anchor's quote; nothing is
 *  written when it can't be placed. */
export interface CreateLiveThreadRequest {
  anchor: LiveAnchor;
  body: string;
  mentions?: string[];
  selection?: RelativeSelection;
}

/** POST /api/threads/:threadId/reanchor: moves a live thread's mark to a
 *  selection, or to the first occurrence of a quote. */
export type ReanchorThreadRequest = ({ target: Target } & RelativeSelection) | { target: Target; quote: string };

export interface CommentBodyRequest {
  body: string;
  mentions?: string[];
}

export interface MentionableUser {
  id: string;
  displayName: string;
  email: string;
}

export interface MentionableUsersResponse {
  users: MentionableUser[];
}

export interface DeletedDocumentEntry {
  id: string;
  title: string;
  deletedAt: string;
  daysRemaining: number;
}

export interface VersionSummaryDTO {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;
  /** True for a checkpoint of a live document (it has a render bundle).
   *  Versions from before the document went live are plain rendered HTML. */
  bundled?: boolean;
}

export interface VersionsListResponse {
  versions: VersionSummaryDTO[];
}

export interface DocumentPatchRequest {
  title?: string;
  description?: string | null;
  /** Owner only (a person, in a session). */
  agentMode?: AgentMode;
}

export interface VersionPatchRequest {
  versionNote: string | null;
}

/** A new version of a live document is merged into it, and `reconciliation`
 *  says what happened to each changed group (applied, suggested, conflict).
 *  When nothing was applied (an agent in suggest mode gets every change as a
 *  suggestion), no version is made: `versionId` and `versionNumber` are
 *  absent and the suggestions are in `reconciliation`. */
export type AddVersionResponse =
  | { versionId: string; versionNumber: number; url: string; reconciliation?: Reconciliation }
  | { versionId?: never; versionNumber?: never; url: string; reconciliation: Reconciliation };

/** Why the server refused a write, with a ready fix the caller (often an
 *  agent) can follow. Codes grow per feature; branch on `code`, never on
 *  message text. */
export type RefusalCode =
  | 'stale_base'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  /** A live edit's target block changed (or is gone) since the version it read. */
  | 'target_changed'
  /** Publishing a new version onto a live document is not supported yet. */
  | 'republish_unsupported'
  /** A comment's selection no longer resolves in the live document. */
  | 'target_missing'
  /** The quoted text was not found in the target. */
  | 'quote_not_found'
  /** An op names an agent run that was cancelled or has finished. */
  | 'run_cancelled'
  /** An op would remove text an open comment thread is on; `details.threads`
   *  lists them. Retry with `allowCommentedDelete` once that is intended. */
  | 'deletes_commented_text'
  /** An op is malformed or can't apply to the document's structure. */
  | 'invalid_op'
  /** The run's edits would pass the large-edit threshold: post a plan and
   *  wait for a person to approve it. */
  | 'approval_required'
  /** The person who asked for the run can't edit the document, so the run
   *  can't either (it may comment). */
  | 'requester_cannot_edit'
  /** An approval named a plan the agent has since replaced. */
  | 'plan_changed'
  /** An agent with an active run on the document wrote without its runId;
   *  `details.runIds` lists the active runs. */
  | 'run_required'
  /** The suggestion was already accepted, rejected or withdrawn. */
  | 'suggestion_closed'
  /** Collaborators: no user has that email. */
  | 'user_not_found'
  /** Collaborators: the user already collaborates on the document. */
  | 'collaborator_exists'
  /** Collaborators: the owner can't be added as a collaborator. */
  | 'owner_not_collaborator'
  /** Collaborators: the role isn't available at the document's visibility. */
  | 'invalid_role_for_visibility'
  /** Collaborators: an actor can't grant a role above its own. */
  | 'role_exceeds_own'
  /** Records: the write would cross a per-document cap (count or bytes) or the per-record size. */
  | 'records_cap'
  /** Records: the record changed since the `expectVersion` the caller read. */
  | 'record_conflict'
  /** Records: the page did not opt in to records, or its access was revoked. */
  | 'records_unavailable'
  /** Records: a page has too many calls in flight, or a call timed out or was cancelled. */
  | 'records_busy'
  /** Choices: the choice is decided, so it takes no more votes or proposals. */
  | 'choice_decided';

export interface Refusal {
  code: RefusalCode;
  message: string;
  /** What to do instead, in one sentence. */
  fix: string;
  details?: Record<string, unknown>;
}

/** The formats a document version can be published from. A `.txt` upload
 *  publishes as `text`. */
export type PublishFormat = 'html' | 'markdown' | 'text';

// ───────────────────── Live documents ─────────────────────
// A live document is one Y.Doc (BlockNote content) edited in place. Three
// version values exist and are never mixed:
// - `versionNumber`: a checkpoint's number (publish preconditions use it);
// - `docVersion`: the id of the latest persisted update; every live read
//   returns it;
// - `LiveBlockDTO.version`: 16 hex chars hashing a block's whole subtree, so
//   editing a child changes its parent's version.

/** The format a live document was imported from. */
export type DocumentFormat = 'markdown' | 'text' | 'html';

/** Who may write on a live document: `auto` lets an agent edit documents it
 *  owns and suggest everywhere else. */
export type AgentMode = 'auto' | 'edit' | 'suggest';

/** The address of everything in a live document. `tabId` is `main` for the
 *  first tab. `pid` (page text), `embedId` and `textId` (widget label) name a
 *  sub-fragment of the block; at most one is set. */
export interface Target {
  tabId: string;
  blockId: string;
  pid?: string;
  textId?: string;
  embedId?: string;
}

/** One block of a live read. `json` is BlockNote partial-block JSON. */
export interface LiveBlockDTO {
  target: Target;
  type: string;
  version: string;
  markdown?: string;
  html?: string;
  json?: Record<string, unknown>;
  depth: number;
  parentId: string | null;
}

export type EditStatus = 'applied' | 'conflict' | 'suggested' | 'unchanged';

/** What happened to one planned edit, by its index in the request. */
export interface EditOutcome {
  index: number;
  target: Target;
  status: EditStatus;
  blocks?: LiveBlockDTO[];
  suggestionId?: string;
  refusal?: Refusal;
  note?: string;
}

/** The one result format of every server write to a live document: ops,
 *  restores, republish merges, page carry-over, branch proposals, run undo. */
export interface Reconciliation {
  docVersion: number;
  outcomes: EditOutcome[];
}

/** The format of a live read's blocks. */
export type LiveReadFormat = 'markdown' | 'html' | 'json';

/** What the person who asked an agent was looking at (M4 runs). */
export interface ViewerContext {
  tabId: string;
  selectedBlockIds: string[];
  cursorBlockId: string | null;
  unsentText?: string;
}

/** GET /api/documents/:docId/live: one tab's blocks, flattened depth-first
 *  (children follow their parent with `depth + 1`). With `since`, only the
 *  blocks changed after that docVersion, plus the ids of deleted ones. */
export interface LiveDocDTO {
  documentId: string;
  docVersion: number;
  at: 'live';
  format: LiveReadFormat;
  tabId: string;
  blocks: LiveBlockDTO[];
  deletedIds?: string[];
  viewer?: ViewerContext;
}

/** A block an agent writes: Markdown (several top-level nodes make several
 *  blocks, one list item per block), one HTML element, or BlockNote partial
 *  block JSON (for custom blocks and props). */
export type BlockInput = string | { html: string } | { json: Record<string, unknown> };

/** One semantic edit of a live document (POST /api/documents/:docId/ops). */
export type LiveOp =
  | { op: 'add'; at: Target; position: 'before' | 'after'; blocks: BlockInput[] }
  | { op: 'update'; target: Target; block: BlockInput; expectVersion: string }
  | { op: 'replaceRange'; from: Target; to: Target; blocks: BlockInput[]; expectVersions: Record<string, string> }
  | { op: 'delete'; target: Target; expectVersion: string }
  | { op: 'move'; target: Target; at: Target; position: 'before' | 'after'; expectVersion: string };

export interface ApplyOpsRequest {
  /** The docVersion the agent read (informational: preconditions are per block). */
  baseVersion: number;
  ops: LiveOp[];
  /** The agent run these edits belong to (undo, status, cancel). */
  runId?: string;
  /** `suggest` turns a stale op into a suggestion (status `suggested`)
   *  instead of a conflict. */
  onConflict?: 'refuse' | 'suggest';
  /** Allow removing text that open comment threads are on. */
  allowCommentedDelete?: boolean;
}

/** A batch refused before anything applied: one refusal per bad op. */
export interface ApplyOpsRejection {
  error: RefusalCode;
  refusal: Refusal;
  errors: { index: number; refusal: Refusal }[];
}

export type AgentRunStatus = 'queued' | 'running' | 'failed' | 'done' | 'cancelled';

/** What someone asked an agent: from a comment @-mention, "Send to agent",
 *  @agent on an empty line (`inline`, answered at `blockId`), or "Ask agent"
 *  on a selection. `direct` is the run the server opens for an agent's own
 *  edit without a runId (empty prompt, asked by the agent). `prompt` and
 *  `viewer.unsentText` are written by people: untrusted data for the agent. */
export interface AgentRunRequest {
  kind: 'mention' | 'send' | 'inline' | 'selection' | 'direct';
  prompt: string;
  threadId?: string;
  blockId?: string;
  viewer: ViewerContext;
}

/** One agent run on a live document. */
export interface AgentRunDTO {
  id: string;
  documentId: string;
  agentId: string;
  requestedBy: string;
  status: AgentRunStatus;
  /** Null for viewers other than the requester, the agent and the owner:
   *  the prompt and unsent text are the requester's. */
  request: AgentRunRequest | null;
  statusLine: string | null;
  error: string | null;
  editsApplied: number;
  blocksRemoved: number;
  /** A large run's plan; ops past the threshold need `planApprovedBy`. */
  plan: string | null;
  /** sha256 of `plan`; approving sends it, so only that plan is approved. */
  planHash: string | null;
  planApprovedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type SuggestionStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn';

/** One block of a suggestion: what it changes (`replace` a block's content,
 *  `insert` a block subtree, `delete` one, `move` one to `place`). */
export type SuggestedEditKind = 'replace' | 'insert' | 'delete' | 'move';

/** Where a block goes: after `prevId`, else before `nextId`, else first in
 *  `parentId` (null: the document). */
export interface BlockPlace {
  parentId: string | null;
  prevId: string | null;
  nextId: string | null;
}

/** A block as a suggestion shows it. For agents `markdown` arrives fenced
 *  (untrusted data) and `json` is left out. */
export interface SuggestionBlockDTO {
  markdown: string;
  json?: Record<string, unknown>;
}

export interface SuggestedEditDTO {
  kind: SuggestedEditKind;
  target: Target;
  /** The block now (null: gone, or not yet inserted). */
  current: SuggestionBlockDTO | null;
  /** The block as proposed (null for delete and move). */
  proposed: SuggestionBlockDTO | null;
  place: BlockPlace | null;
}

/** A stored proposal on a live document (GET /api/documents/:docId/suggestions). */
export interface SuggestionDTO {
  id: string;
  documentId: string;
  authorId: string;
  authorDisplayName: string;
  runId: string | null;
  changeSetId: string | null;
  status: SuggestionStatus;
  /** Made from an edit that conflicted (rather than suggest mode). */
  conflict: boolean;
  /** A block changed since the suggestion was made: accepting is refused
   *  (`target_changed`) until it is made again. */
  stale: boolean;
  createdAt: string;
  edits: SuggestedEditDTO[];
}

export interface SuggestionsResponse {
  suggestions: SuggestionDTO[];
}

/** POST /api/runs/:runId/approve */
export interface ApproveRunRequest {
  planHash: string;
}

/** POST /api/documents/:docId/runs */
export interface CreateRunRequest {
  agentId: string;
  request: AgentRunRequest;
}

/** POST /api/documents/:docId/checkpoints */
export interface CreateCheckpointRequest {
  note?: string | null;
}

/** A checkpoint: a version of a live document captured at `docVersion`. */
export interface CheckpointResponse {
  versionId: string;
  versionNumber: number;
  docVersion: number;
}

/** POST /api/versions/:versionId/restore: the restore is a new edit. */
export type RestoreCheckpointResponse = Reconciliation;

/** GET /api/documents/:docId/export?format= */
export type ExportFormat = 'markdown' | 'text' | 'html';

/** POST /api/documents/:docId/files. The document stores `url`
 *  (`primer-blob://<fileId>`), never an expiring link; it resolves to
 *  GET /api/files/:fileId at read time. */
export interface DocFileUploadResponse {
  fileId: string;
  url: string;
}

export interface AdminStatsBucket {
  total: number;
  last7d: number;
}

export interface DailyPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  value: number;
}

export interface DailyStackPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  documents: number;
  versions: number;
  comments: number;
}

export interface ThreadFlowPoint {
  date: string;
  opened: number;
  resolved: number;
}

export interface TopDocument {
  title: string;
  viewers: number;
}

export interface TopCommenter {
  displayName: string;
  comments: number;
}

export interface HistogramBucket {
  bucket: string;
  count: number;
}

export interface AdminAdoptionBlock {
  createdPerDay: DailyStackPoint[];
  activeUsersPerDay: DailyPoint[];
  cumulativeUsers: DailyPoint[];
}

export interface AdminEngagementBlock {
  topDocumentsByViewers: TopDocument[];
  topCommenters: TopCommenter[];
  viewersPerDocHistogram: HistogramBucket[];
}

export interface AdminOperationalBlock {
  storageBytesPerDay: DailyPoint[];
  threadsOpenedVsResolved: ThreadFlowPoint[];
  openThreadsAgingOver14d: {
    count: number;
    sparkline: DailyPoint[];
  };
}

export interface AdminStatsResponse {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;

  rangeDays: 30;
  adoption: AdminAdoptionBlock;
  engagement: AdminEngagementBlock;
  operational: AdminOperationalBlock;
}

export interface DeviceAuthorizeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  token: string;
  tokenPrefix: string;
  tokenId: string;
  expiresAt: string | null;
}

export interface DeviceTokenPending {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant';
}

export interface DevicePendingResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface DeviceApproveResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
}

/**
 * Permissions an API token can be limited to. A token minted with `scopes`
 * may call only the routes and MCP tools those scopes grant; everything else
 * answers 403 `insufficient_scope`. A scope only narrows what the user's
 * role on a document already allows; it never grants access the role doesn't
 * have. Some operations have no scope at all and are never reachable with a
 * scoped token: deleting or restoring documents, making a document
 * org-visible, external sharing, folders, and token management.
 */
export const API_TOKEN_SCOPES = [
  'documents:read',
  'documents:write',
  'comments:write',
  'events:write',
  'collaborators:manage',
  'users:read',
  'records:read',
  'records:write',
  'records:manage',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const API_TOKEN_SCOPE_DESCRIPTIONS: Record<ApiTokenScope, string> = {
  'documents:read': 'Read documents, versions, content, comments, and events',
  'documents:write':
    'Create documents, upload versions, edit titles, descriptions, and version notes, and make documents private, where your role on the document allows it',
  'comments:write': 'Create, edit, resolve, and delete comments where your role on the document allows it',
  'events:write':
    'Write structured document events where your role on the document allows it (the owner, an editor or a responder)',
  'collaborators:manage':
    'Change who can access documents you own: list, add, change, and remove collaborators',
  'users:read': 'Look up and search users',
  'records:read': "Read a document's shared records, your own personal records, and their change log",
  'records:write':
    'Write and revert shared records, and write your own personal records, where your role on the document allows it (the owner, an editor or a responder)',
  'records:manage': "Delete other people's personal records on documents you own",
};

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === 'string' && (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  /** null = unrestricted (every route an API token may call). */
  scopes: ApiTokenScope[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokensListResponse {
  tokens: ApiTokenSummary[];
}

export interface CreateTokenRequest {
  name: string;
  /** Omit for an unrestricted token. Must be non-empty when present. */
  scopes?: ApiTokenScope[];
}

/**
 * `token` is the plaintext secret and appears ONLY in this response — it is
 * never stored or returned again.
 */
export interface CreateTokenResponse {
  token: string;
  summary: ApiTokenSummary;
}

/** Roles an owner can grant through the collaborators API. The single
 *  source for every surface (API validation, web share UI, MCP client) so a
 *  new role is added in one place rather than re-declared per consumer. */
export const COLLABORATOR_ROLES = ['commenter', 'responder', 'editor'] as const;

export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

export function isCollaboratorRole(v: unknown): v is CollaboratorRole {
  return COLLABORATOR_ROLES.some((r) => r === v);
}

export interface Collaborator {
  userId: string;
  displayName: string;
  role: CollaboratorRole;
  grantedBy: string;
  createdAt: string;
}

export interface CollaboratorsListResponse {
  collaborators: Collaborator[];
}

export interface AddCollaboratorRequest {
  userId: string;
  role: CollaboratorRole;
}

export interface UpdateCollaboratorRequest {
  role: CollaboratorRole;
}

export interface UserSearchHit {
  id: string;
  displayName: string;
  email: string;
}

export interface UserSearchResponse {
  users: UserSearchHit[];
}

export interface FolderDTO {
  id: string;
  name: string;
  docCount: number;
}

export interface LibraryDocument {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
  createdAt: string;
  folderId: string | null;
}

export interface LibraryResponse {
  folders: FolderDTO[];
  documents: LibraryDocument[];
  recentlyDeleted: DeletedDocumentEntry[];
}

export interface ExternalRecipientDto {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstViewedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ExternalShareDto {
  id: string;
  shareToken: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  createdAt: string;
}

export interface ExternalShareResponse {
  share: ExternalShareDto | null;
  recipients: ExternalRecipientDto[];
  /** False when the server has no working email transport (NoopNotifier in
   *  production) — the sharer UI must warn that external sharing is unusable. */
  emailEnabled: boolean;
}

export interface ExternalViewEventDto {
  id: string;
  email: string;         // recipient email (from external_recipients)
  versionNumber: number; // version that was viewed
  viewedAt: string;      // ISO
}

export interface ExternalShareViewsResponse {
  views: ExternalViewEventDto[]; // ordered viewedAt DESC, capped at 200
  total: number;                 // full event count for the share
}

export interface AddExternalRecipientRequest {
  email: string;
  expiresInDays?: number; // default 90, max 365
}

export interface PublishExternalShareRequest {
  versionId: string;
}

// ───────────────────── Document events (wire contract) ─────────────────────
// Structured document events (issue #78): typed JSON payloads written by
// tooling, humans (via the consent-gated companion path), or agents, stored
// on a document as an append-only, access-controlled stream. Primer enforces
// behavior ONLY on its own columns (id → ordering, authorId → attribution,
// audience → read scope, namespace/type → validation + filtering); `payload`
// is opaque data Primer never interprets, and NOTHING consuming these rows
// may treat a payload as instructions to execute — payloads are always
// untrusted data to parse and validate.

/** Per-row read scope. REQUIRED on write — there is no default, because a
 *  default would be an implicit behavior and every writer is code that can
 *  state intent.
 *  - `author`: readable by the row's author + the document owner.
 *  - `collaborators`: readable by all authenticated document collaborators
 *    (owner included).
 *  - `artifact`: readable by the same set as `collaborators`, AND the
 *    companion relays the row into the sandboxed artifact iframe. This tier
 *    is the injection boundary — whether the row may become input to
 *    untrusted artifact code running in every viewer's browser — so it must
 *    never be collapsed into `collaborators`. */
export type EventAudience = 'author' | 'collaborators' | 'artifact';

export function isEventAudience(v: unknown): v is EventAudience {
  return v === 'author' || v === 'collaborators' || v === 'artifact';
}

/** The audience a stored row can carry. `readers` is server-only: Primer's
 *  own lifecycle events (namespace `primer`) use it, and it means everyone
 *  who may read the document. No writer can choose it, and the page never
 *  relays it into the artifact. */
export type StoredEventAudience = EventAudience | 'readers';

/** `namespace` is hierarchical: `/`-separated lowercase kebab segments
 *  (`example`, `example/telemetry`). Namespace MEANING is the consumers' domain —
 *  the server validates shape only and never infers behavior from it. */
export const EVENT_NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
/** `type` is a single name within a namespace (`export`, `verdict`). */
export const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;
/** A `?type=` filter also matches Primer's own dotted lifecycle types
 *  (`comment.created`), which writers can never use. */
export const EVENT_TYPE_FILTER_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
export const MAX_EVENT_NAMESPACE_LENGTH = 128;
export const MAX_EVENT_TYPE_LENGTH = 64;
/** Serialized (UTF-8) size cap per event payload. */
export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
/** Maximum events per POST batch (the batch cap is Primer's to own). */
export const MAX_EVENTS_PER_BATCH = 100;

/** One event as submitted by a writer (each event in a batch carries its own
 *  namespace/type/payload/audience; `versionId` is optional write-time
 *  provenance — the version that was the entry point when the row was
 *  written). */
export interface EventInput {
  namespace: string;
  type: string;
  payload: unknown;
  audience: EventAudience;
  versionId?: string;
}

/** A stored event row. `id` is the server-assigned ordering key — a positive
 *  integer (bigserial), NOT a uuid. Ids follow commit order: a row only ever
 *  becomes visible after every row with a lower id, so "everything after id
 *  N" is a complete resume point. Ids need not be contiguous. `createdAt` is
 *  display-only. `versionId` is present only when the writer declared it. */
export interface EventRowDTO {
  id: number;
  documentId: string;
  versionId?: string;
  authorId: string;
  audience: StoredEventAudience;
  namespace: string;
  type: string;
  payload: unknown;
  createdAt: string; // ISO
}

/** POST /api/documents/:id/events — the body is uniformly a batch (a single
 *  send is a batch of one). All-or-nothing: any invalid event rejects the
 *  whole batch and nothing is inserted. */
export interface SendEventsRequest {
  events: EventInput[];
}

/** 201 response: the created rows, in insertion (array) order, with their
 *  server-assigned ids and stored audiences — the ids are the consumer's
 *  dedupe keys and the echoed audience is how tooling asserts its write
 *  landed with the intended scope. */
export interface SendEventsResponse {
  events: EventRowDTO[];
}

/** GET /api/documents/:id/events — one token-paginated page of ascending-id
 *  rows. Follow `nextPageToken` to exhaustion; page overlaps are harmless
 *  because consumers dedupe by id. */
export interface EventsListResponse {
  events: EventRowDTO[];
  nextPageToken: string | null;
}

/** GET /api/users/lookup?email= — resolve a human-entered email to the
 *  canonical server user id, so consumers can classify authority by
 *  comparing identities against server-attributed row authors in the same
 *  id space. */
export interface UserLookupResponse {
  id: string;
  email: string;
  displayName: string;
}

// ───────────────────── Lifecycle events (server-only) ─────────────────────
// Primer writes these itself, in the same transaction as the change they
// describe. Rows carry namespace `primer`, audience `readers`, and one of the
// types below; the full event name is `primer.<type>` (for example
// `primer.comment.created`). Clients can never write the `primer` namespace.
// Payloads hold ids only — fetch the comment, thread or version for content.

export const PRIMER_EVENT_NAMESPACE = 'primer';

export interface PrimerCommentCreatedPayload {
  document_id: string;
  /** Null for a comment on a live document. */
  version_id: string | null;
  thread_id: string;
  comment_id: string;
  author_id: string;
}

export interface PrimerThreadResolvedPayload {
  document_id: string;
  thread_id: string;
  by: string;
}

/** A thread changed in a way other events don't name: a comment edited,
 *  deleted or restored, or the thread reopened. */
export interface PrimerThreadUpdatedPayload {
  document_id: string;
  thread_id: string;
  by: string;
}

/** A live thread's commented text was removed (`orphaned: true`) or is back
 *  (`orphaned: false`). */
export interface PrimerThreadOrphanedPayload {
  document_id: string;
  thread_id: string;
  orphaned: boolean;
}

export interface PrimerVersionPublishedPayload {
  document_id: string;
  version_id: string;
  number: number;
  author_id: string;
}

/** Someone asked an agent to work on a document. */
export interface PrimerRunRequestedPayload {
  document_id: string;
  run_id: string;
  agent_id: string;
}

/** A run's status, status line or plan changed. */
export interface PrimerRunUpdatedPayload {
  document_id: string;
  run_id: string;
  by: string;
}

/** An agent or a person proposed a change to a live document. */
export interface PrimerSuggestionCreatedPayload {
  document_id: string;
  suggestion_id: string;
  author_id: string;
}

/** A suggestion was accepted, rejected or withdrawn. */
export interface PrimerSuggestionDecidedPayload {
  document_id: string;
  suggestion_id: string;
  decision: 'accepted' | 'rejected' | 'withdrawn';
  by: string;
}

/** Shared records changed. Coalesced per (document, actor) over a short
 *  window; never delivered to the actor who made the changes. Read the
 *  changes with `GET /api/documents/:docId/records/changes?since=<from_change_id - 1>`. */
export interface PrimerDataChangedPayload {
  document_id: string;
  collections: string[];
  from_change_id: number;
  to_change_id: number;
}

/** A person with edit rights picked an option of a choice block. Read the
 *  decision with `GET /api/documents/:docId/decisions`. */
export interface PrimerDecisionMadePayload {
  document_id: string;
  block_id: string;
  option_id: string;
  decided_by: string;
}

/** A person with edit rights cleared a choice's decision. */
export interface PrimerDecisionClearedPayload {
  document_id: string;
  block_id: string;
  cleared_by: string;
}

/** A task block was added (or first indexed). */
export interface PrimerTaskCreatedPayload {
  document_id: string;
  task_id: string;
  block_id: string;
  assignee_id: string | null;
  status: TaskStatus;
}

/** A task's title, assignee, due date or status changed. */
export interface PrimerTaskUpdatedPayload {
  document_id: string;
  task_id: string;
  block_id: string;
  assignee_id: string | null;
  status: TaskStatus;
  changed: ('title' | 'assignee' | 'due' | 'status')[];
}

/** A task block was removed from the document. */
export interface PrimerTaskDeletedPayload {
  document_id: string;
  task_id: string;
  block_id: string;
  assignee_id: string | null;
}

export interface PrimerEventPayloads {
  'comment.created': PrimerCommentCreatedPayload;
  'data.changed': PrimerDataChangedPayload;
  'decision.made': PrimerDecisionMadePayload;
  'decision.cleared': PrimerDecisionClearedPayload;
  'task.created': PrimerTaskCreatedPayload;
  'task.updated': PrimerTaskUpdatedPayload;
  'task.deleted': PrimerTaskDeletedPayload;
  'thread.resolved': PrimerThreadResolvedPayload;
  'thread.updated': PrimerThreadUpdatedPayload;
  'thread.orphaned': PrimerThreadOrphanedPayload;
  'version.published': PrimerVersionPublishedPayload;
  'run.requested': PrimerRunRequestedPayload;
  'run.updated': PrimerRunUpdatedPayload;
  'suggestion.created': PrimerSuggestionCreatedPayload;
  'suggestion.decided': PrimerSuggestionDecidedPayload;
}

export type PrimerEventType = keyof PrimerEventPayloads;

/** The Yjs awareness client id the server uses for an agent's cursor and
 *  status on live documents (fnv1a32 of the agent's id). Clients trust an
 *  agent state only under this id. */
export function agentClientId(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// ───────────────────── Shared records ─────────────────────
// Per-document storage for pages and agents (Claude Artifacts storage). Not
// part of the live document and never tied to page versions. `shared`
// records are visible to every reader; `personal` records only to the viewer
// or agent who wrote them. REST (`POST /api/documents/:docId/records/<verb>`),
// MCP and the page bridge all call the same verbs.

export type RecordScope = 'shared' | 'personal';

export const RECORD_READ_VERBS = ['get', 'list', 'query'] as const;
export const RECORD_WRITE_VERBS = ['set', 'update', 'delete', 'batch'] as const;
export const RECORD_VERBS = [...RECORD_READ_VERBS, ...RECORD_WRITE_VERBS] as const;
export type RecordVerb = (typeof RECORD_VERBS)[number];

/** Collection names: `votes`, `primer.choice/<blockId>`, `query:<name>`. */
export const RECORD_COLLECTION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** A data key in `where` and `orderBy`. */
export const RECORD_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Shared records per document. */
export const MAX_RECORDS_PER_DOCUMENT = 10_000;
export const MAX_RECORDS_BYTES_PER_DOCUMENT = 10 * 1024 * 1024;
/** Personal records per person or agent per document, counted apart from
 *  the shared caps so no viewer can fill a document for everyone. */
export const MAX_PERSONAL_RECORDS_PER_USER = 1_000;
export const MAX_PERSONAL_RECORDS_BYTES_PER_USER = 1024 * 1024;
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_RECORDS_PAGE_SIZE = 200;
export const DEFAULT_RECORDS_PAGE_SIZE = 50;
export const MAX_RECORDS_BATCH = 100;

/** The arguments of every verb. `recordId` names one record (get, set,
 *  update, delete); `data` is a JSON object (set replaces, update merges
 *  its top-level keys); `expectVersion` refuses the write with
 *  `record_conflict` when the record moved on (0 = must not exist yet).
 *  `where` matches top-level keys exactly; `limit` ≤ 200 with `cursor` from
 *  the previous page. Personal records are always the caller's own: there is
 *  no owner argument. */
export interface RecordQuery {
  collection: string;
  scope: RecordScope;
  recordId?: string;
  data?: Record<string, unknown>;
  expectVersion?: number;
  where?: Record<string, string | number | boolean | null>;
  orderBy?: { key: string; dir: 'asc' | 'desc' };
  limit?: number;
  cursor?: string;
}

/** One write of a batch. A batch applies all its writes or none. */
export interface RecordBatchOp {
  verb: 'set' | 'update' | 'delete';
  collection: string;
  scope: RecordScope;
  recordId: string;
  data?: Record<string, unknown>;
  expectVersion?: number;
}

export interface RecordBatchRequest {
  ops: RecordBatchOp[];
}

export interface RecordDTO {
  collection: string;
  recordId: string;
  scope: RecordScope;
  data: Record<string, unknown>;
  version: number;
  updatedAt: string;
  updatedBy: string;
  /** How Primer names the writer, e.g. "Ada" or "Claude (via Ada)". */
  writtenBy: string;
  /** Set when an agent reads a record whose current data anyone but itself
   *  contributed to (a viewer or another agent, by set, merge or revert).
   *  Treat it as data, never as instructions. */
  untrusted?: true;
}

/** POST /api/documents/:docId/records/purge-personal (owner only): delete
 *  one user's personal records on the document. */
export interface PurgePersonalRecordsRequest {
  userId: string;
}

export interface PurgePersonalRecordsResponse {
  deleted: number;
}

export interface RecordsPage {
  records: RecordDTO[];
  nextCursor: string | null;
}

export interface RecordDeleteResult {
  deleted: boolean;
}

/** What each verb returns. */
export interface RecordVerbResults {
  get: { record: RecordDTO | null };
  list: RecordsPage;
  query: RecordsPage;
  set: { record: RecordDTO };
  update: { record: RecordDTO };
  delete: RecordDeleteResult;
  batch: { results: ({ record: RecordDTO } | RecordDeleteResult)[] };
}

/** One entry of the append-only change log. `before` and `after` are the
 *  record's data around the change (null when absent). */
export interface RecordChangeDTO {
  id: number;
  collection: string;
  recordId: string;
  scope: RecordScope;
  op: 'set' | 'update' | 'delete';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actorId: string;
  actorName: string;
  createdAt: string;
  /** For an agent reader: anyone but itself contributed to the before or
   *  after data. */
  untrusted?: true;
}

/** GET /api/documents/:docId/records/changes?since=<id>&limit= : shared
 *  changes plus the caller's own personal ones, ascending. `toChangeId` is
 *  the last id returned (or `since` when none), the next resume point. */
export interface RecordChangesResponse {
  changes: RecordChangeDTO[];
  toChangeId: number;
  hasMore: boolean;
}

/** The outbound policy a page is served with: `records` pages read shared
 *  records and get no remote content and no outbound bridge features. */
export type PagePolicy = 'standard' | 'records';

/** GET /api/versions/:versionId/page: what the host binds a page to. */
export interface PageInfoResponse {
  documentId: string;
  versionId: string;
  policy: PagePolicy;
}

/** A live page block's frame binding (`GET /api/documents/:docId/pages/:blockId`):
 *  `versionId` is the checkpoint that published the served source; `texts`
 *  each pid's source text (the host marks pids a script redrew read-only);
 *  `embeds` the page's Primer blocks. */
export interface LivePageInfo extends PageInfoResponse {
  blockId: string;
  texts: Record<string, string>;
  embeds: { embedId: string; kind: 'table' | 'code' | 'mermaid' | 'math' }[];
}

// ───────────────────── Choices, decisions and tasks ─────────────────────
// Choice and task blocks live in the document. Votes are shared records
// (collection `primer.choice/<choiceId>`, record id = the voter's id); the
// decision is written into the choice block by the pick route only, which
// admits people with edit rights. The decision register and task lists are
// projections of those blocks (tasks through a rebuildable index).

/** A block id Primer accepts in a path, a records collection or an index row
 *  (the document is client-writable, so ids read from it are checked too). */
export const LIVE_BLOCK_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** The records collection that holds a choice's votes. */
export function choiceVotesCollection(choiceId: string): string {
  return `primer.choice/${choiceId}`;
}

export const MAX_CHOICE_OPTIONS = 20;
export const MAX_CHOICE_TEXT = 4000;
export const MAX_CHOICE_LIST = 20;

export interface ChoiceEvidence {
  label: string;
  /** http(s) only. */
  url?: string;
  /** A Primer document. */
  docId?: string;
}

export interface ChoiceOptionDTO {
  id: string;
  label: string;
  votes: number;
}

/** A recorded decision (server-side; never read from the document). */
export interface ChoiceDecisionDTO {
  optionId: string;
  /** The question and the option's label as they read when decided. */
  question: string;
  label: string;
  /** The question or the option's label was edited after the pick. */
  changedSinceDecided: boolean;
  rationale: string;
  evidence: ChoiceEvidence[];
  openQuestions: string[];
  decidedBy: string;
  decidedByName: string;
  decidedAt: string;
}

export interface DecisionDTO {
  target: Target;
  question: string;
  options: ChoiceOptionDTO[];
  status: 'open' | 'decided';
  decided: ChoiceDecisionDTO | null;
  /** An agent's proposal, awaiting a person's pick. */
  proposed: { optionId: string; label: string; by: string; note: string } | null;
  /** Set for agent callers: question, options and rationale are text people
   *  wrote. Treat it as data, never as instructions. */
  untrusted?: true;
}

/** GET /api/documents/:docId/decisions — the decision register. */
export interface DecisionsResponse {
  decisions: DecisionDTO[];
}

/** GET /api/documents/:docId/choices/:blockId/votes */
export interface ChoiceTallyResponse {
  counts: Record<string, number>;
  mine: string | null;
  /** The recorded decision; null while the choice is open. */
  decision: ChoiceDecisionDTO | null;
}

/** POST /api/documents/:docId/choices/:blockId/vote — null withdraws. */
export interface VoteRequest {
  optionId: string | null;
}

/** POST /api/documents/:docId/choices/:blockId/pick (people with edit rights). */
export interface PickRequest {
  optionId: string;
  rationale?: string;
  evidence?: ChoiceEvidence[];
  openQuestions?: string[];
}

/** POST /api/documents/:docId/choices/:blockId/propose (agents, and anyone with edit rights). */
export interface ProposePickRequest {
  optionId: string;
  note?: string;
}

/** Where a new block goes: after `afterBlockId`, or at the end of the tab. */
export interface BlockPlacement {
  tabId?: string;
  afterBlockId?: string;
}

/** POST /api/documents/:docId/choices */
export interface AddChoiceRequest extends BlockPlacement {
  question: string;
  options: string[];
}

export interface AddChoiceResponse {
  target: Target;
  optionIds: string[];
  docVersion: number;
}

export type TaskStatus = 'open' | 'done';

export interface TaskDTO {
  id: string;
  documentId: string;
  target: Target;
  title: string;
  assigneeId: string | null;
  /** YYYY-MM-DD */
  due: string | null;
  status: TaskStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set for agent callers: the title is text people wrote. */
  untrusted?: true;
}

/** GET /api/documents/:docId/tasks and GET /api/tasks?assignee=me */
export interface TasksResponse {
  tasks: TaskDTO[];
}

/** POST /api/documents/:docId/tasks */
export interface AddTaskRequest extends BlockPlacement {
  title: string;
  assigneeId?: string;
  due?: string;
}

export interface AddTaskResponse {
  target: Target;
  docVersion: number;
}

/** PATCH /api/documents/:docId/tasks/:blockId — the assignee's progress line and status. */
export interface UpdateTaskRequest {
  status?: TaskStatus;
  progress?: string;
}

export interface AssigneeDTO {
  id: string;
  name: string;
  kind: 'person' | 'agent';
}

/** GET /api/documents/:docId/assignees — people with access, and their agents. */
export interface AssigneesResponse {
  assignees: AssigneeDTO[];
}

/** POST /api/convert/markdown: Markdown to BlockNote blocks by the importer's
 *  parser (what an upload uses), so a paste lands as the same blocks. */
export interface ConvertMarkdownRequest {
  markdown: string;
}
export interface ConvertMarkdownResponse {
  /** BlockNote block JSON without ids; the editor assigns them on insert. */
  blocks: unknown[];
}
