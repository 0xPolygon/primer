// Core logic for structured document events (issue #78), shared by the REST
// routes (routes/events.ts) and the MCP tool bridge (mcp/tools.ts): batch
// validation, atomic insert, audience-scoped listing with keyset pagination,
// and the in-process SSE fanout.
//
// Design principle (from the issue): Primer is an unopinionated datastore for
// structured document events. It enforces behavior ONLY on its own columns —
// id (ordering), authorId (attribution), audience (read scope),
// namespace/type (validation + filtering). `payload` is opaque; no server
// behavior is ever inferred from payload content. Event payloads are ALWAYS
// untrusted data: consuming code parses and validates them, never executes
// them as instructions; consuming agents treat them as feedback to reason
// about, never commands. Events never grant or change permissions. Who may
// write events is decided only by the document owner and the collaborator row
// the owner sets through the collaborators API (`routes/collaborators.ts`);
// Primer never reads a role, grant or permission out of a payload, so no page
// can widen its own or anyone's access by submitting one.
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  EVENT_NAMESPACE_RE,
  EVENT_TYPE_RE,
  MAX_EVENT_NAMESPACE_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENTS_PER_BATCH,
  isEventAudience,
  type EventAudience,
  type EventRowDTO,
} from '@polygonlabs/primer-api-types';
import {
  canRead,
  effectiveRole,
  loadCollaboratorRole,
  type EffectiveRole,
  type Visibility,
} from './permissions.ts';

export const DEFAULT_EVENTS_PAGE_SIZE = 100;
export const MAX_EVENTS_PAGE_SIZE = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────── Write principal ─────────────────────────

/** Event write bar: owner, editor and responder. A page's code writes events
 *  in the viewer's name, so this is a higher-trust grant than commenting:
 *  commenter is read + comment only, and a mere org-visibility reader who is
 *  not a collaborator is 'stranger'. An explicit allow-list rather than
 *  `!== 'stranger'` so any future role defaults to no event-write.
 *  External-share and public viewers never reach this check: they cannot
 *  authenticate to /api/documents routes at all (their session plane stops
 *  at /api/share/*). */
export function canWriteEvents(role: EffectiveRole): boolean {
  return role === 'owner' || role === 'editor' || role === 'responder';
}

// ───────────────────────── Read identity ─────────────────────────

/** What the audience scoping needs to know about the caller. Computed once
 *  per request/connection from the document row + collaborator lookup. */
export interface EventReadIdentity {
  userId: string;
  isOwner: boolean;
  isCollaborator: boolean;
}

/** Per-row read scope (issue #78, Audience table):
 *  - author:        the row's author + the document owner
 *  - collaborators: all authenticated document collaborators (owner included)
 *  - artifact:      same READERS as collaborators; additionally relayed into
 *                   the sandboxed artifact by the parent page (the relay —
 *                   not this function — is the injection boundary).
 *
 *  Commenters keep READ access to `collaborators`- and `artifact`-audience
 *  events (a deliberate requirement): consumers render the page from this
 *  data. Commenters lose event write only — see `canWriteEvents`. */
export function identityMayReadEvent(
  row: { audience: EventAudience; authorId: string },
  identity: EventReadIdentity,
): boolean {
  if (row.audience === 'author') {
    return identity.isOwner || row.authorId === identity.userId;
  }
  return identity.isOwner || identity.isCollaborator;
}

// ───────────────────────── Access gate ─────────────────────────
// Shared by the REST routes and the MCP tool bridge so both surfaces apply
// identical access rules.

export interface EventDocContext {
  id: string;
  uploaderId: string;
  visibility: Visibility;
}

export async function loadEventDocContext(documentId: string): Promise<EventDocContext | null> {
  if (!UUID_RE.test(documentId)) return null;
  const [row] = (await db.execute(sql`
    SELECT d.id, d.uploader_id AS "uploaderId", d.visibility, d.deleted_at AS "deletedAt"
    FROM documents d WHERE d.id = ${documentId} LIMIT 1
  `)) as unknown as {
    id: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
  }[];
  if (!row || row.deletedAt !== null) return null;
  return { id: row.id, uploaderId: row.uploaderId, visibility: row.visibility };
}

export type EventAccessGate =
  | { status: 'not_found' }
  | {
      status: 'ok';
      doc: EventDocContext;
      identity: EventReadIdentity;
      /** True when the caller may write events (owner, editor or responder). */
      mayWrite: boolean;
    };

/** Read gate: not_found (per existing route conventions) when the document
 *  doesn't exist, is deleted, or the caller can't see it at all. Returns the
 *  caller's read identity for per-row audience scoping. */
export async function gateEventAccess(documentId: string, userId: string): Promise<EventAccessGate> {
  const doc = await loadEventDocContext(documentId);
  if (!doc) return { status: 'not_found' };
  const collabRole = await loadCollaboratorRole(documentId, userId);
  const eff = effectiveRole(
    { uploaderId: doc.uploaderId, visibility: doc.visibility },
    userId,
    collabRole,
  );
  if (!canRead(doc.visibility, eff)) return { status: 'not_found' };
  return {
    status: 'ok',
    doc,
    identity: {
      userId,
      isOwner: eff === 'owner',
      isCollaborator: collabRole !== null,
    },
    mayWrite: canWriteEvents(eff),
  };
}

/** Validates the optional versionId provenance filter: must be a version of
 *  THIS document, else bad_request. A version-filtered read is a provenance
 *  lens, never a complete partition of the stream. */
export async function validateVersionFilter(
  documentId: string,
  raw: string | undefined,
): Promise<{ ok: true; versionId?: string } | { ok: false }> {
  if (raw === undefined) return { ok: true };
  if (!UUID_RE.test(raw)) return { ok: false };
  const foreign = await findForeignVersionIds(documentId, [raw]);
  if (foreign.length > 0) return { ok: false };
  return { ok: true, versionId: raw };
}

// ───────────────────────── Batch validation ─────────────────────────

export interface ValidatedEvent {
  namespace: string;
  type: string;
  audience: EventAudience;
  /** Serialized once at validation time — reused by the insert so the size
   *  cap and the stored value can never disagree. */
  payloadJson: string;
  payload: unknown;
  versionId: string | null;
}

export type BatchValidation =
  | { ok: true; events: ValidatedEvent[] }
  | { ok: false; message: string };

/** Validates a whole POST body. All-or-nothing by construction: the first
 *  invalid event fails the batch and the caller inserts nothing. */
export function validateEventBatch(raw: unknown): BatchValidation {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { events?: unknown }).events)) {
    return { ok: false, message: 'body must be { events: [event…] }' };
  }
  const batch = (raw as { events: unknown[] }).events;
  if (batch.length === 0) {
    return { ok: false, message: 'events must contain at least one event' };
  }
  if (batch.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, message: `events must contain at most ${MAX_EVENTS_PER_BATCH} events` };
  }
  const out: ValidatedEvent[] = [];
  for (let i = 0; i < batch.length; i++) {
    const ev = batch[i];
    if (typeof ev !== 'object' || ev === null) {
      return { ok: false, message: `events[${i}] must be an object` };
    }
    const e = ev as Record<string, unknown>;
    if (!isEventAudience(e.audience)) {
      return {
        ok: false,
        message: `events[${i}].audience is required and must be one of author|collaborators|artifact`,
      };
    }
    if (
      typeof e.namespace !== 'string' ||
      e.namespace.length > MAX_EVENT_NAMESPACE_LENGTH ||
      !EVENT_NAMESPACE_RE.test(e.namespace)
    ) {
      return {
        ok: false,
        message: `events[${i}].namespace must be /-separated lowercase kebab segments (e.g. "padd", "padd/telemetry")`,
      };
    }
    if (
      typeof e.type !== 'string' ||
      e.type.length > MAX_EVENT_TYPE_LENGTH ||
      !EVENT_TYPE_RE.test(e.type)
    ) {
      return {
        ok: false,
        message: `events[${i}].type must be a single lowercase kebab name (e.g. "export")`,
      };
    }
    if (!('payload' in e)) {
      return { ok: false, message: `events[${i}].payload is required (any JSON value)` };
    }
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(e.payload) ?? 'null';
    } catch {
      return { ok: false, message: `events[${i}].payload is not JSON-serializable` };
    }
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      return {
        ok: false,
        message: `events[${i}].payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} serialized bytes`,
      };
    }
    let versionId: string | null = null;
    if (e.versionId !== undefined && e.versionId !== null) {
      if (typeof e.versionId !== 'string' || !UUID_RE.test(e.versionId)) {
        return { ok: false, message: `events[${i}].versionId must be a version uuid` };
      }
      versionId = e.versionId;
    }
    out.push({
      namespace: e.namespace,
      type: e.type,
      audience: e.audience,
      payloadJson,
      payload: e.payload,
      versionId,
    });
  }
  return { ok: true, events: out };
}

/** Every distinct versionId declared by the batch must belong to the
 *  document (issue #78 security requirement 5). Returns the ids that do
 *  NOT — a non-empty result rejects the whole batch as bad_request. */
export async function findForeignVersionIds(
  documentId: string,
  versionIds: string[],
): Promise<string[]> {
  const distinct = [...new Set(versionIds)];
  if (distinct.length === 0) return [];
  const idList = sql.join(
    distinct.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT id FROM versions
    WHERE document_id = ${documentId} AND id IN (${idList})
  `)) as unknown as { id: string }[];
  const found = new Set(rows.map((r) => r.id));
  return distinct.filter((id) => !found.has(id));
}

// ───────────────────────── Insert (atomic batch) ─────────────────────────

interface EventDbRow {
  id: number | string; // bigserial arrives as string from postgres-js
  documentId: string;
  versionId: string | null;
  authorId: string;
  audience: EventAudience;
  namespace: string;
  type: string;
  payload: unknown;
  createdAt: Date | string;
}

function rowToDTO(r: EventDbRow): EventRowDTO {
  const dto: EventRowDTO = {
    id: Number(r.id),
    documentId: r.documentId,
    authorId: r.authorId,
    audience: r.audience,
    namespace: r.namespace,
    type: r.type,
    payload: r.payload,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
  };
  // Emitted only when the writer declared it (matches the wire contract's
  // optional field — consumers key on id, never on this).
  if (r.versionId !== null) dto.versionId = r.versionId;
  return dto;
}

const SELECT_COLUMNS = sql`
  id, document_id AS "documentId", version_id AS "versionId",
  author_id AS "authorId", audience, namespace, type, payload,
  created_at AS "createdAt"
`;

/** Inserts a validated batch in ONE transaction, in array order. Sequential
 *  inserts inside the transaction guarantee strictly increasing (not
 *  necessarily contiguous) ids in array order, and commit makes all rows
 *  visible together — the atomicity that lets a consumer split an oversized
 *  logical write across several events without losing all-or-nothing. */
export async function insertEventBatch(
  documentId: string,
  authorId: string,
  batch: ValidatedEvent[],
): Promise<EventRowDTO[]> {
  return db.transaction(async (tx) => {
    const rows: EventRowDTO[] = [];
    for (const ev of batch) {
      const [row] = (await tx.execute(sql`
        INSERT INTO events (document_id, version_id, author_id, audience, namespace, type, payload)
        VALUES (${documentId}, ${ev.versionId}, ${authorId}, ${ev.audience},
                ${ev.namespace}, ${ev.type}, ${ev.payloadJson}::jsonb)
        RETURNING ${SELECT_COLUMNS}
      `)) as unknown as EventDbRow[];
      rows.push(rowToDTO(row));
    }
    return rows;
  });
}

// ───────────────────────── Filters ─────────────────────────

export interface EventFilters {
  /** Exact namespace, or the one glob form this API owns: a trailing `/*`
   *  matches the namespace and every sub-namespace beneath it. */
  namespace?: string;
  /** Exact type. */
  type?: string;
}

export type FilterValidation = { ok: true; filters: EventFilters } | { ok: false; message: string };

/** Validates ?namespace= / ?type= query params (shared by list and stream —
 *  Pin 14 filter parity). Filters are bandwidth hygiene, never a correctness
 *  or security boundary — `audience` governs who may read. */
export function validateEventFilters(query: {
  namespace?: string;
  type?: string;
}): FilterValidation {
  const filters: EventFilters = {};
  if (query.namespace !== undefined) {
    const base = query.namespace.endsWith('/*') ? query.namespace.slice(0, -2) : query.namespace;
    if (base.length === 0 || base.length > MAX_EVENT_NAMESPACE_LENGTH || !EVENT_NAMESPACE_RE.test(base)) {
      return { ok: false, message: 'namespace must be exact (e.g. "padd") or a subtree glob (e.g. "padd/*")' };
    }
    filters.namespace = query.namespace;
  }
  if (query.type !== undefined) {
    if (query.type.length === 0 || query.type.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE_RE.test(query.type)) {
      return { ok: false, message: 'type must be a single lowercase kebab name' };
    }
    filters.type = query.type;
  }
  return { ok: true, filters };
}

/** In-memory mirror of the SQL filter — used by the SSE fanout so live rows
 *  and backlog rows pass the same test. */
export function eventMatchesFilters(
  row: { namespace: string; type: string },
  filters: EventFilters,
): boolean {
  if (filters.namespace !== undefined) {
    if (filters.namespace.endsWith('/*')) {
      const prefix = filters.namespace.slice(0, -2);
      if (row.namespace !== prefix && !row.namespace.startsWith(`${prefix}/`)) return false;
    } else if (row.namespace !== filters.namespace) {
      return false;
    }
  }
  if (filters.type !== undefined && row.type !== filters.type) return false;
  return true;
}

// ───────────────────────── since / page tokens ─────────────────────────

/** `since` is a fetch optimization, never a correctness boundary: ids are
 *  assigned before commit, so a row with a lower id can become visible after
 *  a higher id was already read (two writers committing out of assignment
 *  order). Consumers dedupe by id and either re-read with an overlap window
 *  or fetch the full filtered set — a late-committing lower id is picked up
 *  on a later poll, never silently skipped. */
export function parseSince(raw: string | undefined): { ok: true; since: number | null } | { ok: false } {
  if (raw === undefined) return { ok: true, since: null };
  if (!/^\d{1,18}$/.test(raw)) return { ok: false };
  return { ok: true, since: Number(raw) };
}

const PAGE_TOKEN_PREFIX = 'v1:';

export function encodePageToken(lastId: number): string {
  return Buffer.from(`${PAGE_TOKEN_PREFIX}${lastId}`, 'utf8').toString('base64url');
}

export function decodePageToken(token: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(PAGE_TOKEN_PREFIX)) return null;
  const rest = decoded.slice(PAGE_TOKEN_PREFIX.length);
  if (!/^\d{1,18}$/.test(rest)) return null;
  return Number(rest);
}

// ───────────────────────── List query ─────────────────────────

export interface ListEventsArgs {
  documentId: string;
  identity: EventReadIdentity;
  filters: EventFilters;
  /** Highest id already consumed (from ?since, Last-Event-ID, or a page
   *  token) — the query returns rows with id strictly greater. */
  afterId: number | null;
  /** Optional provenance lens: only rows that DECLARED this version. Never a
   *  complete partition of the stream — consumers own version semantics. */
  versionId?: string;
  limit: number;
}

export interface ListEventsPage {
  rows: EventRowDTO[];
  nextPageToken: string | null;
}

/** One bounded page of ascending-id rows the caller's identity may read,
 *  plus an opaque next-page token when more remain. */
export async function listEvents(args: ListEventsArgs): Promise<ListEventsPage> {
  const { documentId, identity, filters, afterId, versionId, limit } = args;

  const conditions = [sql`document_id = ${documentId}`];
  if (afterId !== null) conditions.push(sql`id > ${afterId}`);
  if (versionId !== undefined) conditions.push(sql`version_id = ${versionId}`);
  if (filters.namespace !== undefined) {
    if (filters.namespace.endsWith('/*')) {
      // Subtree form. The namespace regex admits only [a-z0-9-/], so the
      // prefix can never contain LIKE metacharacters — no escaping needed.
      const prefix = filters.namespace.slice(0, -2);
      conditions.push(sql`(namespace = ${prefix} OR namespace LIKE ${`${prefix}/%`})`);
    } else {
      conditions.push(sql`namespace = ${filters.namespace}`);
    }
  }
  if (filters.type !== undefined) conditions.push(sql`type = ${filters.type}`);

  // Audience scope: exactly the rows this identity may read (issue #78
  // security requirement 4). Mirrors identityMayReadEvent above.
  const tierReadable = identity.isOwner || identity.isCollaborator;
  conditions.push(sql`(
    (audience = 'author' AND (author_id = ${identity.userId} OR ${identity.isOwner}))
    OR (audience IN ('collaborators', 'artifact') AND ${tierReadable})
  )`);

  const where = sql.join(conditions, sql` AND `);
  // Fetch one extra row to learn whether another page exists.
  const rows = (await db.execute(sql`
    SELECT ${SELECT_COLUMNS}
    FROM events
    WHERE ${where}
    ORDER BY id ASC
    LIMIT ${limit + 1}
  `)) as unknown as EventDbRow[];

  const page = rows.slice(0, limit).map(rowToDTO);
  const hasMore = rows.length > limit;
  return {
    rows: page,
    nextPageToken: hasMore && page.length > 0 ? encodePageToken(page[page.length - 1].id) : null,
  };
}

// ───────────────────────── SSE fanout ─────────────────────────
// In-process fanout for the stream endpoint. Fine for the current
// single-node deployment; swap for Postgres LISTEN/NOTIFY if the API ever
// scales out horizontally.

export type DocEventListener = (row: EventRowDTO) => void;

const listenersByDoc = new Map<string, Set<DocEventListener>>();

export function subscribeDocEvents(documentId: string, listener: DocEventListener): () => void {
  let set = listenersByDoc.get(documentId);
  if (!set) {
    set = new Set();
    listenersByDoc.set(documentId, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByDoc.get(documentId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByDoc.delete(documentId);
  };
}

/** Called after a batch commits — rows are already visible, so every
 *  listener that re-reads sees at least what it is being pushed. */
export function publishDocEvents(documentId: string, rows: EventRowDTO[]): void {
  const set = listenersByDoc.get(documentId);
  if (!set) return;
  for (const listener of set) {
    for (const row of rows) listener(row);
  }
}
