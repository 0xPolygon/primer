import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ThreadsListResponse } from '@primer/shared/api';

// Module-level ETag cache keyed by versionId so re-renders don't lose it.
const etagByVersion = new Map<string, string>();

interface CachedShape {
  data: ThreadsListResponse;
  etag: string | null;
}

async function fetchConditional(
  versionId: string,
  previous: CachedShape | undefined,
  signal: AbortSignal
): Promise<CachedShape> {
  const headers: Record<string, string> = {};
  const cachedEtag = etagByVersion.get(versionId);
  if (cachedEtag) headers['if-none-match'] = cachedEtag;

  const res = await fetch(`/api/versions/${versionId}/threads`, { headers, signal });

  if (res.status === 304) {
    if (previous) return previous;
    // Cache miss but server said 304 — drop the ETag and refetch unconditionally.
    etagByVersion.delete(versionId);
    return fetchConditional(versionId, undefined, signal);
  }

  if (!res.ok) {
    throw new Error(`threads fetch failed: ${res.status}`);
  }

  const data = (await res.json()) as ThreadsListResponse;
  const etag = res.headers.get('etag');
  if (etag) etagByVersion.set(versionId, etag);
  return { data, etag };
}

export function useThreadsQuery(versionId: string) {
  const qc = useQueryClient();
  const [paused, setPaused] = useState(typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return useQuery({
    queryKey: ['threads', versionId],
    queryFn: async ({ signal }) => {
      const previous = qc.getQueryData<CachedShape>(['threads', versionId]);
      return fetchConditional(versionId, previous, signal);
    },
    refetchInterval: paused ? false : 10_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
    enabled: versionId.length > 0,
  });
}

export type ThreadsQueryShape = CachedShape;

export function clearThreadsEtag(versionId: string): void {
  etagByVersion.delete(versionId);
}
