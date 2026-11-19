// Three-way carry-over of people's page text across an agent republish (M6.5).
//
// For each pid of the new page, `base` is the pid's stamped text in the last
// publish, `mine` the text people left in its fragment and `theirs` the
// agent's new text:
//
//   | condition                                   | fragment ends with               |
//   | new pid (no base)                           | theirs                           |
//   | mine == base                                | theirs                           |
//   | uncertain match and mine != base            | theirs, suggestion of mine       |
//   | theirs == base                              | mine (carried)                   |
//   | mine == theirs                              | theirs                           |
//   | all three differ                            | theirs, suggestion of mine       |
//
// Repeated labels and other ambiguous matches are never carried silently.
// `mine` is read inside the edit's `build`, on the document queue, so text
// typed while the plan waits is never lost.
import type { Target } from '@polygonlabs/primer-api-types';
import type { PlannedEdit } from '../live/pipeline.ts';
import type { PidInfo } from './stamp.ts';
import { docText, writeText } from './text.ts';

export type CarryResult = { text: string; suggest: string | null; carried: boolean };

export function carryText(base: string | undefined, mine: string | undefined, theirs: string, uncertain: boolean): CarryResult {
  const keep = { text: theirs, suggest: null, carried: false };
  if (base === undefined || mine === undefined || mine === base) return keep;
  if (mine === theirs) return keep;
  if (uncertain) return { text: theirs, suggest: mine, carried: false };
  if (theirs === base) return { text: mine, suggest: null, carried: true };
  return { text: theirs, suggest: mine, carried: false };
}

export type CarryDecision = CarryResult & { pid: string; target: Target };

/**
 * One edit per pid of the new page. Each records its decision in `decisions`
 * when it runs, so the caller can turn `suggest` rows into suggestions on the
 * same targets.
 */
export function planCarry(opts: {
  tabId: string;
  blockId: string;
  previous: PidInfo[];
  next: PidInfo[];
  uncertain: string[];
  decisions: CarryDecision[];
}): PlannedEdit[] {
  const base = new Map(opts.previous.map((p) => [p.pid, p.text]));
  const uncertain = new Set(opts.uncertain);
  return opts.next.map((p) => {
    const target: Target = { tabId: opts.tabId, blockId: opts.blockId, pid: p.pid };
    return {
      target,
      inverse: false,
      build: (tr) => {
        const mine = base.has(p.pid) ? docText(tr.doc) : undefined;
        const result = carryText(base.get(p.pid), mine, p.text, uncertain.has(p.pid));
        opts.decisions.push({ ...result, pid: p.pid, target });
        writeText(tr, p.pid, result.text);
      },
    };
  });
}
