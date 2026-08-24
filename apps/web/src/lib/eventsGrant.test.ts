// Tests for the first-submission grant engine (issue #78, security
// requirement 6) — the adversarial cases the design must hold against:
// version-bound grant keys (republish re-prompts), audience-escalation
// re-prompts that batch-splitting cannot bypass, and the single-held-
// submission rule (no queue-jumping or piggybacking on a grant click).
import { describe, it, expect } from 'vitest';
import type { EventInput } from '@polygonlabs/primer-api-types';
import {
  AUDIENCE_RANK,
  createGrantStore,
  decideSubmission,
  grantKey,
  requiredTier,
  summarizeEnvelope,
  type GrantStorageLike,
} from './eventsGrant.ts';

const ev = (audience: EventInput['audience'], namespace = 'padd'): EventInput => ({
  namespace,
  type: 'export',
  payload: { secret: 'never-disclosed' },
  audience,
});

function memoryStorage(): GrantStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('audience tier ordering', () => {
  it('author < collaborators < artifact (each reader set contains the previous)', () => {
    expect(AUDIENCE_RANK.author).toBeLessThan(AUDIENCE_RANK.collaborators);
    expect(AUDIENCE_RANK.collaborators).toBeLessThan(AUDIENCE_RANK.artifact);
  });

  it('requiredTier is the broadest tier present in the submission', () => {
    expect(requiredTier([ev('author')])).toBe('author');
    expect(requiredTier([ev('author'), ev('collaborators')])).toBe('collaborators');
    expect(requiredTier([ev('collaborators'), ev('artifact'), ev('author')])).toBe('artifact');
  });
});

describe('grant key binds to the artifact CONTENT version', () => {
  const base = { userId: 'u1', documentId: 'd1', versionId: 'v1' };

  it('a republished artifact (new version id) has a different key — re-prompts', () => {
    expect(grantKey(base)).not.toBe(grantKey({ ...base, versionId: 'v2' }));
  });

  it('different viewers and different documents never share a grant', () => {
    expect(grantKey(base)).not.toBe(grantKey({ ...base, userId: 'u2' }));
    expect(grantKey(base)).not.toBe(grantKey({ ...base, documentId: 'd2' }));
  });
});

describe('decideSubmission — the submission-path policy', () => {
  it('prompts on the first submission (no grant)', () => {
    expect(decideSubmission({ events: [ev('author')], granted: null, promptOpen: false })).toBe('prompt');
  });

  it('forwards when the grant covers the required tier (equal or broader)', () => {
    expect(
      decideSubmission({ events: [ev('collaborators')], granted: 'collaborators', promptOpen: false }),
    ).toBe('forward');
    expect(decideSubmission({ events: [ev('author')], granted: 'artifact', promptOpen: false })).toBe('forward');
  });

  it('re-prompts on audience escalation past the granted tier', () => {
    expect(decideSubmission({ events: [ev('artifact')], granted: 'collaborators', promptOpen: false })).toBe('prompt');
    expect(decideSubmission({ events: [ev('collaborators')], granted: 'author', promptOpen: false })).toBe('prompt');
  });

  it('splitting a batch cannot bypass the escalation re-prompt', () => {
    // The artifact was granted `author`, then tries to sneak the broader
    // tier through as separate submissions: each submission's required tier
    // is computed from its OWN events, so the broad one still prompts.
    const granted = 'author' as const;
    expect(decideSubmission({ events: [ev('author')], granted, promptOpen: false })).toBe('forward');
    expect(decideSubmission({ events: [ev('artifact')], granted, promptOpen: false })).toBe('prompt');
    expect(decideSubmission({ events: [ev('author'), ev('artifact')], granted, promptOpen: false })).toBe('prompt');
  });

  it('refuses outright while a prompt is open — nothing queue-jumps or piggybacks on the grant click', () => {
    // Even a submission the existing grant WOULD cover is refused while the
    // prompt for a held submission is open: the viewer is mid-decision on a
    // specific disclosed envelope.
    expect(decideSubmission({ events: [ev('author')], granted: 'artifact', promptOpen: true })).toBe('refuse_pending');
    expect(decideSubmission({ events: [ev('artifact')], granted: null, promptOpen: true })).toBe('refuse_pending');
  });
});

describe('grant store', () => {
  const scope = { userId: 'u1', documentId: 'd1', versionId: 'v1' };

  it('round-trips a grant and keeps the BROADEST tier ever granted', () => {
    const storage = memoryStorage();
    const store = createGrantStore(storage);
    expect(store.load(scope)).toBeNull();
    store.save(scope, 'collaborators');
    expect(store.load(scope)).toBe('collaborators');
    store.save(scope, 'artifact');
    expect(store.load(scope)).toBe('artifact');
    // A later narrower grant never REDUCES the recorded disclosure.
    store.save(scope, 'author');
    expect(store.load(scope)).toBe('artifact');
  });

  it('a grant for one version says nothing about another (republish re-prompts)', () => {
    const store = createGrantStore(memoryStorage());
    store.save(scope, 'artifact');
    expect(store.load({ ...scope, versionId: 'v2' })).toBeNull();
  });

  it('ignores garbage in storage and survives a throwing storage (session-only grants)', () => {
    const storage = memoryStorage();
    storage.map.set(grantKey(scope), 'everyone'); // not a valid tier
    const store = createGrantStore(storage);
    expect(store.load(scope)).toBeNull();

    const throwing: GrantStorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const sessionStore = createGrantStore(throwing);
    expect(sessionStore.load(scope)).toBeNull(); // failure → prompt, never silently grant
    sessionStore.save(scope, 'artifact');
    expect(sessionStore.load(scope)).toBe('artifact'); // in-memory carries the session
  });

  it('works with no storage at all (null) — grants last the page load', () => {
    const store = createGrantStore(null);
    store.save(scope, 'collaborators');
    expect(store.load(scope)).toBe('collaborators');
  });
});

describe('disclosure envelope', () => {
  it('shows count, unique namespaces, and audiences broadest-first — never payload bytes', () => {
    const envelope = summarizeEnvelope([
      ev('author', 'padd'),
      ev('artifact', 'padd/telemetry'),
      ev('artifact', 'padd'),
    ]);
    expect(envelope).toEqual({
      eventCount: 3,
      namespaces: ['padd', 'padd/telemetry'],
      audiences: ['artifact', 'author'],
      required: 'artifact',
    });
    // The envelope type carries no payloads; assert the value doesn't either.
    expect(JSON.stringify(envelope)).not.toContain('never-disclosed');
  });
});
