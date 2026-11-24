import { flushAutoCheckpoints } from './live/autoCheckpoint.ts';
import { flushDecisionSync } from './live/choices.ts';
import { flushMentionSync } from './live/mentions.ts';
import { flushOrphanSync } from './live/orphans.ts';
import { drainDocQueues } from './live/queue.ts';
import { flushTaskSync } from './live/tasks.ts';
import { logger } from './logger.ts';
import { inflightCount, settleInflight } from './inflight.ts';
import { flushDataChanged } from './records/changed.ts';

/** The longest the shutdown drain may take: Kubernetes allows 30 s by default. */
export const DRAIN_BOUND_MS = 15_000;

/**
 * Writes everything still pending, once no requests or sockets come in:
 * first the queued live updates (the document itself); then the data.changed
 * windows, whose widget redraws write live documents; then the syncs, which
 * read the live state into rows (mentions, decisions, tasks, orphaned
 * threads); then the automatic checkpoints, of the final state; and last
 * whatever those queued (redraw writes, compactions). One failing step is
 * logged and the rest still run. Notification sends still in flight are awaited
 * alongside the writes. The whole drain is bounded: past `boundMs` it logs what
 * was still running and returns, so shutdown carries on.
 */
export async function drainPendingWork(boundMs: number = DRAIN_BOUND_MS): Promise<void> {
  let running = 'starting';
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), boundMs);
  });
  const outcome = await Promise.race([drain((name) => { running = name; }).then(() => 'done' as const), expired]);
  clearTimeout(timer);
  if (outcome === 'expired') {
    logger.error({ boundMs, step: running, sendsInFlight: inflightCount() }, 'shutdown: pending work did not finish in time, continuing shutdown');
  }
}

async function drain(onStep: (name: string) => void): Promise<void> {
  const step = (name: string, work: () => Promise<unknown>) => {
    onStep(name);
    return work().catch((err: unknown) => logger.error({ error: String(err) }, `shutdown: ${name} failed`));
  };
  // Sends run alongside the writes, so one that never settles holds up nothing else.
  const sends = step('notification sends', settleInflight);
  await step('saving live updates', drainDocQueues);
  await step('writing data.changed', flushDataChanged);
  await Promise.all([
    step('mention sync', flushMentionSync),
    step('decision sync', flushDecisionSync),
    step('task sync', flushTaskSync),
    step('thread orphan check', flushOrphanSync),
  ]);
  await step('automatic checkpoints', flushAutoCheckpoints);
  await step('saving live updates', drainDocQueues);
  await sends;
}
