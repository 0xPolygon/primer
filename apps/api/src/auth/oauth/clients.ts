import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../../db/client.ts';
import { oauthClients } from '@primer/shared/schema';
import { generateClientId } from './tokens.ts';

/**
 * Exact-URI allowlist. Add entries here as new MCP clients are onboarded.
 * Loopback URIs (http://127.0.0.1:<any port>) are always accepted for local dev.
 */
export const REDIRECT_URI_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
] as const;

export function isRedirectUriAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return true;
  return REDIRECT_URI_ALLOWLIST.includes(uri);
}

export interface OAuthClientRow {
  id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: Date | string;
}

export async function getClient(clientId: string): Promise<OAuthClientRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, client_id AS "clientId", client_name AS "clientName",
           redirect_uris AS "redirectUris", grant_types AS "grantTypes",
           token_endpoint_auth_method AS "tokenEndpointAuthMethod",
           created_at AS "createdAt"
    FROM oauth_clients WHERE client_id = ${clientId} LIMIT 1
  `)) as unknown as OAuthClientRow[];
  return rows[0] ?? null;
}

export interface CreateClientInput {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
}

export async function createClient(input: CreateClientInput): Promise<OAuthClientRow> {
  const id = uuidv7();
  const clientId = generateClientId();
  await db.insert(oauthClients).values({
    id,
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes,
    tokenEndpointAuthMethod: 'none',
  });
  const row = await getClient(clientId);
  if (!row) throw new Error('createClient failed to read back inserted row');
  return row;
}
