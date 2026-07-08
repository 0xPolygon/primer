export function isPlausibleEmail(email: string): boolean {
  const e = email.trim();
  return e.length > 0 && e.length <= 320 && e.includes('@') && !e.startsWith('@') && !e.endsWith('@');
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function contentUrl(shareToken: string): string {
  return `/api/share/${shareToken}/content`;
}

/** Plain fetch with the CSRF header. Deliberately NOT lib/fetch.ts `api()`:
 *  its 401 handler redirects to the internal Okta login. */
export async function shareApi(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Primer-Csrf', '1');
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  return fetch(path, { ...init, headers });
}
