import { useEffect, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { agentClientId } from '@polygonlabs/primer-api-types';

type AgentState = { agentId?: string; status?: string; user?: { name?: string; color?: string } };

/** What agents working on the document are doing now (their status line,
 *  set by the server through awareness while a run is running). Awareness
 *  is client-writable: the server strips agent fields from people's updates
 *  and drops any update under a running agent's client id, and an entry
 *  counts here only under the client id the server uses for its agent. */
export function AgentStatus({ provider }: { provider: HocuspocusProvider }) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const read = () =>
      setAgents(
        [...awareness.getStates()].flatMap(([clientId, raw]) => {
          const s = raw as AgentState;
          return s.agentId && s.status && clientId === agentClientId(s.agentId) ? [s] : [];
        }),
      );
    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [provider]);
  if (agents.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-4 pt-2" aria-live="polite" data-agent-status>
      {agents.map((a) => (
        <span key={a.agentId} className="inline-flex items-center gap-1.5 rounded border border-neutral-200 px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
          <span className="h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: a.user?.color ?? '#7c3aed' }} />
          <span className="font-medium">{a.user?.name}</span>
          <span>{a.status}</span>
        </span>
      ))}
    </div>
  );
}
