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
