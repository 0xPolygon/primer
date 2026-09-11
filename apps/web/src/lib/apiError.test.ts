import { describe, it, expect } from 'vitest';
import { ApiError, parseApiError, describeApiError, isNonLatestVersionError } from './apiError.ts';

describe('parseApiError', () => {
  it('extracts code and message from the API error shape', async () => {
    const res = new Response(
      JSON.stringify({ error: 'not_latest_version', message: 'Cannot post to a non-latest version.' }),
      { status: 409 },
    );
    const err = await parseApiError(res);
    expect(err.status).toBe(409);
    expect(err.code).toBe('not_latest_version');
    expect(err.message).toBe('Cannot post to a non-latest version.');
  });

  it('falls back to a generic message when the body has no message', async () => {
    const res = new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const err = await parseApiError(res);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Request failed (404)');
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    const res = new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const err = await parseApiError(res);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe('Request failed (502)');
  });

  it('ignores a non-string message field', async () => {
    const res = new Response(JSON.stringify({ error: 'bad_request', message: 42 }), { status: 400 });
    const err = await parseApiError(res);
    expect(err.message).toBe('Request failed (400)');
  });
});

describe('describeApiError', () => {
  it('returns the ApiError message', () => {
    const err = new ApiError(409, 'Cannot post to a non-latest version.', 'not_latest_version');
    expect(describeApiError(err)).toBe('Cannot post to a non-latest version.');
  });

  it('returns a generic message for a plain Error (e.g. network failure)', () => {
    expect(describeApiError(new TypeError('Failed to fetch'))).toBe('Something went wrong. Please try again.');
  });

  it('returns a generic message for a non-Error throw', () => {
    expect(describeApiError('oops')).toBe('Something went wrong. Please try again.');
  });
});

describe('isNonLatestVersionError', () => {
  it('is true only for the not_latest_version code', () => {
    expect(isNonLatestVersionError(new ApiError(409, 'x', 'not_latest_version'))).toBe(true);
    expect(isNonLatestVersionError(new ApiError(400, 'x', 'invalid_body'))).toBe(false);
    expect(isNonLatestVersionError(new Error('x'))).toBe(false);
  });
});
