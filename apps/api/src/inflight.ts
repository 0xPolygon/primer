/** Fire-and-forget sends (notification emails) still running. Shutdown awaits them. */
const inflight = new Set<Promise<unknown>>();

/** Registers a send that nobody awaits; returns it unchanged. */
export function track<T>(work: Promise<T>): Promise<T> {
  inflight.add(work);
  const done = () => { inflight.delete(work); };
  work.then(done, done);
  return work;
}

export function inflightCount(): number {
  return inflight.size;
}

/** Resolves once every tracked send has settled, including ones added meanwhile. */
export async function settleInflight(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}
