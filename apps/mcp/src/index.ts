/**
 * `@polygonlabs/primer-mcp` entrypoint.
 *
 * Two modes:
 *   1. `primer-mcp login` (argv[2] === 'login') — interactive CLI device
 *      login. Prints the verification URL + user code, polls until approved
 *      (or denied/expired), persists the token to the local store, exits.
 *   2. Default (no subcommand) — boots the stdio MCP server with the full
 *      tool surface (`primer_login`, `primer_login_status`, `primer_whoami`, …).
 *
 * Both modes share the same token store (`tokenStore.ts`) so an in-agent
 * login and a CLI login interleave safely (atomic temp+rename writes).
 *
 * Why exit-before-construct for the CLI: the MCP transport uses stdio for
 * the JSON-RPC protocol. If we constructed the McpServer in CLI mode, any
 * stdout we emitted ("Logged in.") would be parsed as a frame. The CLI
 * path returns from `main` before we ever touch the server.
 *
 * Why we never print the token: the spec is unambiguous (Section 6 — token
 * at rest). The token is written to the store, the prefix is shown if
 * useful, and the user is told they're logged in. Pasting the bare token
 * into a terminal makes it land in shell history and CI logs.
 */

import * as os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PrimerApiError, PrimerClient } from './client.ts';
import { pollUntil, startDeviceLogin } from './deviceLogin.ts';
import { clearToken, loadToken, resolveToken, saveToken } from './tokenStore.ts';
import { registerTools } from './tools.ts';
import { MCP_INSTRUCTIONS, registerAuthoringResource } from './authoring.ts';

/** Heartbeat cadence for the CLI long-poll loop. */
const HEARTBEAT_MS = 15_000;

/** Hard cap for each pollUntil call. Matches the in-agent default. */
const POLL_WINDOW_MS = 90_000;

function requireBaseUrl(): string {
  const url = process.env.PRIMER_API_URL;
  if (!url || url.length === 0) {
    process.stderr.write('PRIMER_API_URL is required.\n');
    process.exit(1);
  }
  return url;
}

/**
 * Runs the CLI device-login loop. Calls `pollUntil` repeatedly — each call
 * is bounded by `POLL_WINDOW_MS` and may resolve with `pending` when its
 * internal timeout fires; in that case we loop again, optionally emitting
 * a heartbeat so the user knows the CLI is alive.
 *
 * Heartbeat policy: print "Still waiting..." at most once per
 * `HEARTBEAT_MS`. We track `lastHeartbeat` as the wall-clock of the last
 * print (initialized to the loop start so we don't print on the very first
 * pending — that would be noise within the first 90s window).
 */
async function runCliLogin(baseUrl: string): Promise<never> {
  let authorize;
  try {
    authorize = await startDeviceLogin({ baseUrl, clientLabel: os.hostname() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  // Strict format from spec Section 5. Never include verificationUriComplete.
  process.stdout.write(`Open this URL in your browser:\n  ${authorize.verificationUri}\n\n`);
  process.stdout.write(`Then type this code on the page:\n  ${authorize.userCode}\n`);

  let lastHeartbeat = Date.now();

  for (;;) {
    let state;
    try {
      state = await pollUntil({
        baseUrl,
        deviceCode: authorize.deviceCode,
        interval: authorize.interval,
        timeoutMs: POLL_WINDOW_MS,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }

    if (state.status === 'approved') {
      await saveToken({
        baseUrl,
        tokenId: state.tokenId,
        token: state.token,
        prefix: state.tokenPrefix,
      });
      process.stdout.write('Logged in.\n');
      process.exit(0);
    }

    if (state.status === 'denied') {
      process.stderr.write('Access denied.\n');
      process.exit(1);
    }

    if (state.status === 'expired') {
      process.stderr.write('Login expired. Please run primer-mcp login again.\n');
      process.exit(1);
    }

    // state.status === 'pending' — pollUntil's window elapsed without
    // a terminal answer. Loop again, throttling the heartbeat so we
    // don't spam if pollUntil happens to return quickly.
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      process.stdout.write('Still waiting...\n');
      lastHeartbeat = now;
    }
  }
}

async function runMcpServer(baseUrl: string): Promise<void> {
  // Resolves a token on every tool invocation. The token can change between
  // calls (in-agent `primer_login_status` writes the store mid-session) and
  // we don't want to bake a stale `null` into a long-lived client.
  async function clientBuilder(): Promise<PrimerClient | null> {
    const token = await resolveToken({ env: process.env, baseUrl });
    if (!token) return null;
    return new PrimerClient({ baseUrl, token });
  }

  const server = new McpServer({ name: 'primer', version: '0.0.0' }, { instructions: MCP_INSTRUCTIONS });
  registerAuthoringResource(server);
  registerTools(server, {
    baseUrl,
    clientBuilder,
    store: {
      saveToken: (opts) => saveToken(opts),
      loadToken: (url) => loadToken(url),
      clearToken: (url) => clearToken(url),
      resolveToken: (url) => resolveToken({ env: process.env, baseUrl: url }),
    },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main(): Promise<void> {
  const baseUrl = requireBaseUrl();

  if (process.argv[2] === 'login') {
    await runCliLogin(baseUrl);
    return; // unreachable — runCliLogin always exits
  }

  await runMcpServer(baseUrl);
}

main().catch((err) => {
  // Last-resort handler. The CLI path handles its own errors and exits;
  // anything reaching here is a server boot failure (transport, registration).
  const message =
    err instanceof PrimerApiError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
