/**
 * The seeded service account representing Claude itself (see the
 * seed_service_user migration). Its API tokens are minted from the
 * admin-gated section of /settings/tokens; actions performed with them are
 * attributed to this user. The id can never collide with an Okta sub, so
 * this account cannot log in interactively.
 */
export const SERVICE_USER_ID = 'service-claude';

/**
 * Parses the ADMIN_EMAILS env var (comma-separated) into a normalized
 * (trimmed, lowercased) list. Unset/empty means no admins — fail closed.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** Case-insensitive allowlist check. `adminEmails` must come from parseAdminEmails. */
export function isAdmin(user: { email: string }, adminEmails: string[]): boolean {
  return adminEmails.includes(user.email.toLowerCase());
}
