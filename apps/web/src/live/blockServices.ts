import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  PRIMER_EVENT_NAMESPACE,
  type AssigneesResponse,
  type ChoiceTallyResponse,
  type EventRowDTO,
} from '@polygonlabs/primer-api-types';
import { BLOCK_TEXT_EN, type Assignee, type BlockText, type ChoiceTally, type PickInput, type PrimerBlockServices } from '@primer/blocks';
import { t, type MessageKey } from '../i18n/index.ts';
import { api } from '../lib/fetch.ts';
import { browserEventSourceFactory, type EventSourceLike } from '../lib/eventsFeed.ts';

/**
 * What Primer's choice and task blocks need from the API, for one document:
 * vote tallies and decisions (votes are records, decisions are the server's
 * record, neither lives in the document), voting and picking, and who a task
 * can be assigned to. Others' votes arrive as `primer.data.changed` and
 * decisions as `primer.decision.made` on the document's event stream; this
 * viewer's own vote updates its tally from the vote's response.
 */
export type ChoiceStore = {
  get(choiceId: string): ChoiceTally | null;
  subscribe(choiceId: string, listener: () => void): () => void;
  set(choiceId: string, tally: ChoiceTally): void;
  refresh(choiceId?: string): void;
  /** Bumped on every change, so the register re-reads. */
  version(): number;
  subscribeAll(listener: () => void): () => void;
  /** Follows the document's event stream until the returned function runs. */
  connect(): () => void;
};

export function createChoiceStore(
  documentId: string,
  deps: { fetchImpl: typeof api; eventSourceFactory: (url: string) => EventSourceLike } = {
    fetchImpl: api,
    eventSourceFactory: browserEventSourceFactory,
  },
): ChoiceStore {
  const tallies = new Map<string, ChoiceTally>();
  const listeners = new Map<string, Set<() => void>>();
  const all = new Set<() => void>();
  let changes = 0;
  const base = `/api/documents/${encodeURIComponent(documentId)}`;

  const notify = (choiceId: string) => {
    changes++;
    for (const l of listeners.get(choiceId) ?? []) l();
    for (const l of all) l();
  };
  // A failed read keeps the last tally; the next event or reconnect reads again.
  const load = async (choiceId: string) => {
    try {
      const res = await deps.fetchImpl(`${base}/choices/${encodeURIComponent(choiceId)}/votes`);
      if (!res.ok) return;
      tallies.set(choiceId, (await res.json()) as ChoiceTallyResponse);
      notify(choiceId);
    } catch {
      // Offline or navigating away.
    }
  };
  const refresh = (choiceId?: string) => {
    if (choiceId) void load(choiceId);
    else {
      for (const id of listeners.keys()) void load(id);
      changes++;
      for (const l of all) l();
    }
  };

  return {
    get: (id) => tallies.get(id) ?? null,
    subscribe(choiceId, listener) {
      let set = listeners.get(choiceId);
      if (!set) {
        set = new Set();
        listeners.set(choiceId, set);
        void load(choiceId);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    set(choiceId, tally) {
      tallies.set(choiceId, tally);
      notify(choiceId);
    },
    refresh,
    version: () => changes,
    subscribeAll(listener) {
      all.add(listener);
      return () => all.delete(listener);
    },
    connect() {
      const stream = deps.eventSourceFactory(`${base}/events/stream?namespace=${PRIMER_EVENT_NAMESPACE}`);
      stream.onopen = () => refresh();
      stream.onmessage = (ev) => {
        let row: EventRowDTO;
        try {
          row = JSON.parse(ev.data) as EventRowDTO;
        } catch {
          return;
        }
        const payload = row.payload as { collections?: unknown; block_id?: unknown };
        if ((row.type === 'decision.made' || row.type === 'decision.cleared') && typeof payload.block_id === 'string') {
          refresh(payload.block_id);
        }
        if (row.type === 'data.changed' && Array.isArray(payload.collections)) {
          for (const c of payload.collections) {
            if (typeof c === 'string' && c.startsWith('primer.choice/')) refresh(c.slice('primer.choice/'.length));
          }
        }
      };
      return () => stream.close();
    },
  };
}

async function failure(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { refusal?: { message?: string }; message?: string };
    return new Error(body.refusal?.message ?? body.message ?? `request failed (${res.status})`);
  } catch {
    return new Error(`request failed (${res.status})`);
  }
}

/** The blocks' strings in the viewer's locale (keys `blocks.<name>`). */
const blockText = Object.fromEntries(
  Object.keys(BLOCK_TEXT_EN).map((key) => [key, t(`blocks.${key}` as MessageKey)]),
) as BlockText;

/** The services the web editor gives Primer's blocks, and the choice store
 *  behind them (the decision register reads it too). */
export function useBlockServices(
  documentId: string,
  access: { canPick: boolean; canVote: boolean },
): { services: PrimerBlockServices; store: ChoiceStore } {
  const store = useMemo(() => createChoiceStore(documentId), [documentId]);
  // Connected by an effect, so a remount (React runs effects twice in
  // development) reconnects instead of reusing a closed stream.
  useEffect(() => store.connect(), [store]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  useEffect(() => {
    let live = true;
    // On failure the picker offers only Unassigned.
    void api(`/api/documents/${encodeURIComponent(documentId)}/assignees`)
      .then(async (res) => {
        if (res.ok && live) setAssignees(((await res.json()) as AssigneesResponse).assignees);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [documentId]);

  const services = useMemo<PrimerBlockServices>(() => {
    const base = `/api/documents/${encodeURIComponent(documentId)}/choices`;
    return {
      canPick: access.canPick,
      canVote: access.canVote,
      assignees,
      text: blockText,
      useTally(choiceId: string) {
        return useSyncExternalStore(
          (listener) => store.subscribe(choiceId, listener),
          () => store.get(choiceId),
        );
      },
      async vote(choiceId: string, optionId: string) {
        const current = store.get(choiceId);
        const res = await api(`${base}/${encodeURIComponent(choiceId)}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionId: current?.mine === optionId ? null : optionId }),
        });
        if (!res.ok) throw await failure(res);
        store.set(choiceId, (await res.json()) as ChoiceTallyResponse);
      },
      async pick(choiceId: string, input: PickInput) {
        const res = await api(`${base}/${encodeURIComponent(choiceId)}/pick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw await failure(res);
        store.refresh(choiceId);
      },
    };
  }, [documentId, store, assignees, access.canPick, access.canVote]);
  return { services, store };
}
