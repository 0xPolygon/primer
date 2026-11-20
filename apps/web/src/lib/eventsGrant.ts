/**
 * First-submission grant for artifact-originated event submissions
 * (issue #78, security requirement 6).
 *
 * The consent gate in the companion proves a physical interaction happened;
 * it cannot prove the viewer understood WHAT the artifact submits as them or
 * WHO will see it — the submit affordance lives inside untrusted artifact
 * code. This module closes that gap: the first time a given artifact
 * CONTENT VERSION attempts an artifact-originated submission on a document,
 * Primer-owned chrome (outside the iframe — the artifact cannot draw over
 * it, dispatch events into it, or synthesize acceptance) discloses the
 * envelope (event count, namespaces, each event's audience with its
 * plain-language meaning — never the payload bytes) and asks the viewer to
 * allow it. This is an ADDITIONAL necessary condition layered on the
 * in-dispatch consent gate, not a replacement.
 *
 * Grant semantics:
 *  - persists per (viewer, document, artifact content version) — a
 *    republished artifact is a NEW version, so it re-prompts;
 *  - the grant records the broadest audience tier that was DISCLOSED
 *    (author < collaborators < artifact); a later submission carrying a
 *    broader tier than granted re-prompts — the disclosure was
 *    audience-specific, so escalation invalidates it. Splitting a batch
 *    cannot bypass this: every submission's required tier is computed from
 *    its own events and checked against the grant independently;
 *  - while a prompt is open, exactly ONE submission is held (the one whose
 *    envelope is being disclosed). Any further submission arriving while
 *    the prompt is open is refused immediately — a grant click forwards
 *    exactly the disclosed envelope, never a queue-jumper or piggyback.
 *
 * Storage decision (spec left it to Primer): CLIENT-SIDE, localStorage,
 * keyed by (userId, documentId, versionId) — fronted by an in-memory map so
 * a storage failure degrades to per-page-load grants. Rationale: a grant is
 * a per-viewer disclosure acknowledgment, not shared state; per-device
 * persistence errs toward MORE disclosure (a new device re-prompts), adds
 * zero API surface for the artifact to probe, and matches the app's
 * existing pattern for per-viewer UI state. Server-side persistence can be
 * layered later without changing this module's contract.
 */
import type { EventAudience, EventInput } from '@polygonlabs/primer-api-types';
import { t } from '../i18n';

/** Audience-tier ordering used for "broader": author < collaborators <
 *  artifact (each tier's reader set strictly contains the previous). */
export const AUDIENCE_RANK: Record<EventAudience, number> = {
  author: 0,
  collaborators: 1,
  artifact: 2,
};

/** Plain-language audience meanings shown in the prompt — the disclosure
 *  moment. The viewer must come away understanding WHO will see the
 *  structured data the artifact submits on their behalf. */
export const AUDIENCE_MEANING: Record<EventAudience, string> = {
  artifact:
    t('libEventsGrant.audienceArtifact'),
  collaborators: t('libEventsGrant.audienceCollaborators'),
  author: t('libEventsGrant.audienceAuthor'),
};

/** The broadest audience tier a submission carries — what a grant must
 *  cover. Computed per submission, so splitting a batch cannot smuggle a
 *  broader tier past an earlier, narrower disclosure. */
export function requiredTier(events: EventInput[]): EventAudience {
  let max: EventAudience = 'author';
  for (const e of events) {
    if (AUDIENCE_RANK[e.audience] > AUDIENCE_RANK[max]) max = e.audience;
  }
  return max;
}

/** The disclosure envelope: what the prompt shows. Never payload bytes. */
export interface GrantEnvelope {
  eventCount: number;
  /** Unique namespaces, in first-appearance order. */
  namespaces: string[];
  /** Unique audiences present, broadest first. */
  audiences: EventAudience[];
  /** The tier a grant must cover (broadest present). */
  required: EventAudience;
}

export function summarizeEnvelope(events: EventInput[]): GrantEnvelope {
  const namespaces: string[] = [];
  const audienceSet = new Set<EventAudience>();
  for (const e of events) {
    if (!namespaces.includes(e.namespace)) namespaces.push(e.namespace);
    audienceSet.add(e.audience);
  }
  const audiences = [...audienceSet].sort((a, b) => AUDIENCE_RANK[b] - AUDIENCE_RANK[a]);
  return { eventCount: events.length, namespaces, audiences, required: requiredTier(events) };
}

/** Minimal storage slice (localStorage-shaped) so the store is testable and
 *  storage failures are non-fatal. */
export interface GrantStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface GrantScope {
  userId: string;
  documentId: string;
  /** The artifact CONTENT version rendered in the iframe — the code being
   *  trusted. A republish creates a new version id, hence a new prompt.
   *  Deliberately NOT the document id and NOT the events' declared
   *  versionIds (those are payload provenance, chosen by the artifact). */
  versionId: string;
}

export function grantKey(scope: GrantScope): string {
  return `primer.eventsGrant.${scope.userId}.${scope.documentId}.${scope.versionId}`;
}

const AUDIENCES: EventAudience[] = ['author', 'collaborators', 'artifact'];

/**
 * Grant store: in-memory map fronting persistent storage. The in-memory map
 * is authoritative for the session; storage is best-effort persistence
 * (private windows, blocked site data, and quota errors degrade to
 * per-page-load grants — i.e. MORE prompting, never less).
 */
export function createGrantStore(storage: GrantStorageLike | null) {
  const session = new Map<string, EventAudience>();

  function load(scope: GrantScope): EventAudience | null {
    const key = grantKey(scope);
    const mem = session.get(key) ?? null;
    let stored: EventAudience | null = null;
    try {
      const raw = storage?.getItem(key) ?? null;
      if (raw !== null && (AUDIENCES as string[]).includes(raw)) {
        stored = raw as EventAudience;
      }
    } catch {
      // storage unavailable — session map still applies
    }
    if (mem === null) return stored;
    if (stored === null) return mem;
    return AUDIENCE_RANK[mem] >= AUDIENCE_RANK[stored] ? mem : stored;
  }

  function save(scope: GrantScope, tier: EventAudience): void {
    const key = grantKey(scope);
    const existing = load(scope);
    const next = existing !== null && AUDIENCE_RANK[existing] > AUDIENCE_RANK[tier] ? existing : tier;
    session.set(key, next);
    try {
      storage?.setItem(key, next);
    } catch {
      // best-effort persistence; the session map carries the grant
    }
  }

  return { load, save };
}

export type GrantStore = ReturnType<typeof createGrantStore>;

/** The submission-path decision, kept pure so the adversarial cases are
 *  directly testable without a DOM:
 *  - 'forward'        — an existing grant covers this submission's tier;
 *  - 'prompt'         — no grant, or the tier escalates past the granted
 *                        one: hold THIS submission and disclose;
 *  - 'refuse_pending' — a prompt is already open for a held submission;
 *                        nothing may queue-jump or piggyback on that
 *                        grant-click, so this one is refused outright. */
export function decideSubmission(args: {
  events: EventInput[];
  granted: EventAudience | null;
  promptOpen: boolean;
  /** Whether the viewer's role lets them write events. `false` refuses up
   *  front: asking a viewer to consent to a submission the server will
   *  refuse anyway is a dead end. `undefined` (role not loaded yet) keeps the
   *  normal path; the server still decides. */
  mayWrite?: boolean;
}): 'forward' | 'prompt' | 'refuse_pending' | 'refuse_role' {
  if (args.mayWrite === false) return 'refuse_role';
  if (args.promptOpen) return 'refuse_pending';
  const required = requiredTier(args.events);
  if (args.granted !== null && AUDIENCE_RANK[args.granted] >= AUDIENCE_RANK[required]) {
    return 'forward';
  }
  return 'prompt';
}
