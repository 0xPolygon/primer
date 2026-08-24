import { useMutation } from '@tanstack/react-query';
import type { EventInput, SendEventsResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

/**
 * POST /api/documents/:id/events — the parent page is the authed principal
 * for artifact-originated submissions (the sandboxed artifact has no network
 * path of its own). The body is always a batch; the response echoes the
 * created rows so the ack into the iframe carries server-attributed truth.
 */
export function useSendEvents(docId: string) {
  return useMutation({
    mutationFn: async (events: EventInput[]): Promise<SendEventsResponse> => {
      const res = await api(`/api/documents/${docId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          message = body.message ?? body.error ?? message;
        } catch {
          // keep the HTTP status message
        }
        throw new Error(message);
      }
      return (await res.json()) as SendEventsResponse;
    },
  });
}
