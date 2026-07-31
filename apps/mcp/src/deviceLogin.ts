import type { DeviceAuthorizeResponse, DeviceTokenSuccess } from '@polygonlabs/primer-api-types';
import { PrimerApiError } from './client.ts';

/**
 * Stateless device-authorization helpers used by the MCP server's
 * `primer_login_start` / `primer_login_status` tools and by the
 * `primer-mcp login` CLI.
 *
 * Why "stateless" matters (spec D15): the caller threads the deviceCode
 * back into pollOnce / pollUntil. We never stash it inside the helper —
 * MCP tool invocations are independent, so any per-call state has to be
 * surfaced to the caller for them to persist.
 *
 * Why pollUntil returns `pending` on timeout instead of throwing (spec D16):
 * `primer_login_status` is invoked from a model loop that wants to re-call
 * on its own cadence. A timeout is an expected mid-flow signal, not an
 * error condition — surfacing it as a typed status keeps the tool layer
 * branch-free of try/catch noise.
 */

export type PollState =
  | {
      status: 'approved';
      token: string;
      tokenPrefix: string;
      tokenId: string;
      expiresAt: string | null;
    }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' };

export interface StartLoginOpts {
  baseUrl: string;
  clientLabel?: string;
  fetchImpl?: typeof fetch;
}

export interface PollOpts {
  baseUrl: string;
  deviceCode: string;
  fetchImpl?: typeof fetch;
}

export interface PollUntilOpts extends PollOpts {
  /** Seconds between polls, taken from the authorize response. */
  interval: number;
  /** Hard cap for the whole long-poll window. Default 90s. */
  timeoutMs?: number;
  /** Injectable for tests. Default sleeps real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Default `Date.now`. */
  nowFn?: () => number;
}

// ─────────────────────────────── Internals ───────────────────────────────

/** slow_down doubles the interval; we cap at 60s to avoid pathological waits. */
const SLOW_DOWN_INTERVAL_CAP_SECONDS = 60;

/** Total network errors tolerated across the whole pollUntil window before we
 *  surface to the caller. Three retries = four total attempts. */
const NETWORK_RETRY_BUDGET = 3;

const DEFAULT_TIMEOUT_MS = 90_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

function resolveFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  const f = fetchImpl ?? globalThis.fetch;
  // Bind to preserve `this` for the global fetch (undici is strict).
  return ((input, init) => f(input, init)) as typeof fetch;
}

interface JsonErrorBody {
  error?: string;
  message?: string;
}

async function parseJsonBody(res: Response): Promise<unknown | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PrimerApiError('network', message);
  }
}

// ─────────────────────────────── Public API ───────────────────────────────

export async function startDeviceLogin(
  opts: StartLoginOpts,
): Promise<DeviceAuthorizeResponse> {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const fetchImpl = resolveFetch(opts.fetchImpl);
  const body: Record<string, unknown> = {};
  if (opts.clientLabel !== undefined) body.clientLabel = opts.clientLabel;

  const res = await postJson(fetchImpl, `${baseUrl}/api/device/authorize`, body);

  if (!res.ok) {
    const parsed = (await parseJsonBody(res)) as JsonErrorBody | null;
    const message =
      parsed?.message ?? parsed?.error ?? res.statusText ?? `HTTP ${res.status}`;
    throw new PrimerApiError('bad_request', message, res.status);
  }

  const parsed = (await parseJsonBody(res)) as DeviceAuthorizeResponse | null;
  if (!parsed) {
    throw new PrimerApiError('bad_request', 'empty or non-JSON authorize response', res.status);
  }
  return parsed;
}

export async function pollOnce(opts: PollOpts): Promise<PollState> {
  const baseUrl = stripTrailingSlash(opts.baseUrl);
  const fetchImpl = resolveFetch(opts.fetchImpl);

  const res = await postJson(fetchImpl, `${baseUrl}/api/device/token`, {
    deviceCode: opts.deviceCode,
  });

  if (res.status === 200) {
    const parsed = (await parseJsonBody(res)) as DeviceTokenSuccess | null;
    if (!parsed || typeof parsed.token !== 'string') {
      throw new PrimerApiError('bad_request', 'empty or invalid token response', 200);
    }
    return {
      status: 'approved',
      token: parsed.token,
      tokenPrefix: parsed.tokenPrefix,
      tokenId: parsed.tokenId,
      expiresAt: parsed.expiresAt,
    };
  }

  if (res.status === 400) {
    const parsed = (await parseJsonBody(res)) as JsonErrorBody | null;
    const code = parsed?.error;
    switch (code) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
      case 'invalid_grant':
        // `invalid_grant` collapses to `expired` per spec — both are terminal
        // and the user-facing remedy is identical (start a fresh login).
        return { status: 'expired' };
      default:
        throw new PrimerApiError(
          'bad_request',
          parsed?.message ?? parsed?.error ?? 'unknown device-token error',
          400,
        );
    }
  }

  // Any other status (incl. 5xx) — collapse to bad_request, preserve status.
  const parsed = (await parseJsonBody(res)) as JsonErrorBody | null;
  const message =
    parsed?.message ?? parsed?.error ?? res.statusText ?? `HTTP ${res.status}`;
  throw new PrimerApiError('bad_request', message, res.status);
}

export async function pollUntil(opts: PollUntilOpts): Promise<PollState> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const nowFn = opts.nowFn ?? Date.now;
  const start = nowFn();

  let currentInterval = opts.interval;
  let networkErrors = 0;

  // Loop invariant: we re-check timeout *before* sleeping so we never
  // overshoot — but we also bound the maximum number of fetches as a
  // safety net so a misconfigured sleep can't busy-loop the test runner.
  for (;;) {
    let state: PollState;
    try {
      state = await pollOnce({
        baseUrl: opts.baseUrl,
        deviceCode: opts.deviceCode,
        fetchImpl: opts.fetchImpl,
      });
    } catch (err) {
      if (err instanceof PrimerApiError && err.code === 'network') {
        networkErrors += 1;
        if (networkErrors > NETWORK_RETRY_BUDGET) throw err;
        if (nowFn() - start >= timeoutMs) return { status: 'pending' };
        await sleep(currentInterval * 1000);
        continue;
      }
      throw err;
    }

    if (state.status === 'approved' || state.status === 'denied' || state.status === 'expired') {
      return state;
    }

    if (state.status === 'slow_down') {
      currentInterval = Math.min(currentInterval * 2, SLOW_DOWN_INTERVAL_CAP_SECONDS);
      if (nowFn() - start >= timeoutMs) return { status: 'pending' };
      await sleep(currentInterval * 1000);
      continue;
    }

    // state.status === 'pending'
    if (nowFn() - start >= timeoutMs) return { status: 'pending' };
    await sleep(currentInterval * 1000);
  }
}
