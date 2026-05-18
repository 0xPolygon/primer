const CSRF_HEADER = 'X-Primer-Csrf';

/**
 * Wraps fetch() with two app-wide concerns:
 *   1. CSRF header on every request (the server rejects mutating verbs without it,
 *      and adding it to GETs is harmless).
 *   2. On 401, redirect the whole window to /auth/login?return_to=<current path>
 *      so a session expiring mid-app drops the user back to Okta cleanly.
 */
export async function api(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has(CSRF_HEADER)) {
    headers.set(CSRF_HEADER, '1');
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/auth/login?return_to=${returnTo}`;
    // Return the response so callers don't crash, but the redirect already started.
    return res;
  }
  return res;
}
