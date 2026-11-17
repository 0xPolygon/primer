/**
 * Structured error for a failed `/api/*` call. The API's error responses are
 * consistently `{ error: <code>, message?: <human text> }` (see
 * apps/api/src/routes/*.ts), but callers were throwing a generic Error built
 * from the raw response text — unreadable JSON landed wherever the message
 * surfaced, and several call sites didn't surface it at all (the failure was
 * only visible in devtools). This carries the parsed code/message through so
 * a UI can show the server's own words, and — for `not_latest_version`
 * specifically — offer the right recovery action instead of a dead end.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code: string | undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Builds an ApiError from a non-ok Response. Reads the body as JSON when
 *  possible; falls back to a generic status-based message for a body that
 *  isn't the API's usual `{ error, message }` shape (e.g. a proxy error
 *  page). Never throws — always resolves to an ApiError. */
export async function parseApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.message === 'string' && body.message.trim().length > 0) {
      message = body.message;
    }
    if (typeof body.error === 'string') {
      code = body.error;
    }
  } catch {
    // Non-JSON error body — keep the generic status message.
  }
  return new ApiError(res.status, message, code);
}

/** Human-readable text for any error a comment/thread mutation can throw.
 *  Falls back to a generic message for non-ApiErrors (e.g. a network
 *  failure never reached the server, so there's no server message to show). */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}

/** True when the error is the "post to a non-latest version" guard
 *  (apps/api/src/routes/threads.ts) — the one failure mode with a specific
 *  recovery action (switch to the latest version) rather than just retrying. */
export function isNonLatestVersionError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'not_latest_version';
}
