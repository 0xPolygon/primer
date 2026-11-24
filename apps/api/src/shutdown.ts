import { flushAutoCheckpoints } from './live/autoCheckpoint.ts';
import { flushDecisionSync } from './live/choices.ts';
import { flushMentionSync } from './live/mentions.ts';
import { drainDocQueues } from './live/queue.ts';
import { flushTaskSync } from './live/tasks.ts';
import { logger } from './logger.ts';
import { flushDataChanged } from './records/changed.ts';

/**
 * Writes everything still pending, once no requests or sockets come in:
 * first the queued live updates (the document itself); then the data.changed
 * windows, whose widget redraws write live documents; then the syncs, which
 * read the live state into rows; then the automatic checkpoints, of the final
 * state; and last whatever those queued (redraw writes, compactions). One
 * failing step is logged and the rest still run.
 */
export async function drainPendingWork(): Promise<void> {
  const step = (name: string, work: () => Promise<unknown>) =>
    work().catch((err: unknown) => logger.error({ error: String(err) }, `shutdown: ${name} failed`));
  await step('saving live updates', drainDocQueues);
  await step('writing data.changed', flushDataChanged);
  await Promise.all([
    step('mention sync', flushMentionSync),
    step('decision sync', flushDecisionSync),
    step('task sync', flushTaskSync),
  ]);
  await step('automatic checkpoints', flushAutoCheckpoints);
  await step('saving live updates', drainDocQueues);
}
