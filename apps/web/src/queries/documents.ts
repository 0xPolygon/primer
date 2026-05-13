import { useQuery } from '@tanstack/react-query';
import type { DocumentDetailResponse } from '@primer/shared/api';

export function useDocument(docId: string) {
  return useQuery({
    queryKey: ['document', docId],
    queryFn: async (): Promise<DocumentDetailResponse> => {
      const res = await fetch(`/api/documents/${docId}`);
      if (res.status === 404) {
        throw new Error('not_found');
      }
      if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
      }
      return res.json();
    },
  });
}
