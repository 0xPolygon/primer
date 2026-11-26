/**
 * Agents are `users` rows with `kind = 'agent'`. They never sign in: they act
 * through API tokens (minted by their person, routes/agents.ts) or OAuth
 * (one agent per client and person, auth/oauth/bearer.ts).
 *
 * Their email is synthetic and unroutable, so `/api/users/lookup` never
 * resolves a person's address to one of their agents and no mail is sent to
 * an agent.
 */
export function agentEmail(agentId: string): string {
  return `${agentId}@agents.primer.invalid`;
}
