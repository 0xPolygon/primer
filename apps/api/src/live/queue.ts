/**
 * One serial queue per live document. Everything that must not interleave on a
 * document runs through it: appending updates, compaction, checkpoint capture
 * and the mutation step of `applyPlan`. A job never waits on a later job of
 * the same queue (it would wait forever); hand such a promise out instead.
 *
 * In-process only: Primer runs one API instance (see lib/events.ts wakes).
 */
const tails = new Map<string, Promise<unknown>>();

export function docQueue(documentId: string): <T>(job: () => Promise<T>) => Promise<T> {
  return <T>(job: () => Promise<T>): Promise<T> => {
    const previous = tails.get(documentId) ?? Promise.resolve();
    const run = previous.then(job, job);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(documentId, tail);
    void tail.then(() => {
      if (tails.get(documentId) === tail) tails.delete(documentId);
    });
    return run;
  };
}

/** Waits until every queue is empty, jobs queued meanwhile included (shutdown). */
export async function drainDocQueues(): Promise<void> {
  while (tails.size > 0) await Promise.all([...tails.values()]);
}
