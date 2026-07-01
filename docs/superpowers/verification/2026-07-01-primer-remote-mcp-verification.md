# Primer Remote MCP + OAuth 2.1 Verification Report

**Date:** 2026-07-01  
**Issue:** #30  
**Branch:** `issue-30-remote-mcp-oauth`  

---

## Regression Results

### Step 2: Full API Test Suite

**Command:** `pnpm --filter @primer/api test`

**Result:** ✓ PASSED

- **Test Files:** 53 passed
- **Tests:** 442 passed
- **Duration:** 28.52s

All existing tests pass, including device-flow tests. The OAuth bearer resolver does not steal or interfere with existing PAT (bearer token) authentication or session-based flows.

### Step 3: Stdio MCP Test Suite

**Command:** `pnpm --filter @polygonlabs/primer-mcp test`

**Result:** ✓ PASSED

- **Test Files:** 5 passed
- **Tests:** 100 passed
- **Duration:** 490ms

The stdio MCP path is untouched. No regression.

### Step 4: Typecheck All Packages

**Command:** `pnpm -r typecheck`

**Result:** ✓ PASSED

All packages typecheck successfully:
- `packages/shared` ✓
- `apps/api` ✓
- `apps/mcp` ✓
- `apps/web` ✓

Fixed two minor TypeScript compatibility issues:
1. Updated `registerOAuthRoutes` function signature to accept `Hono<any>` to handle typed Hono instances.
2. Fixed `token.ts` error function to properly handle numeric status codes via type assertion.

---

## Manual Verification Checklist (Deferred)

The following manual verification steps are deferred to the maintainer and will be performed against a deployed or staging instance. These checks require a running API with `OAUTH_ISSUER` configured.

### Discovery & Registration

- [ ] **Discovery endpoint:** `curl http://localhost:3000/.well-known/oauth-authorization-server` returns valid OAuth 2.1 metadata JSON.
- [ ] **Protected-resource metadata:** `curl http://localhost:3000/.well-known/oauth-protected-resource` returns valid RFC 8707 metadata.
- [ ] **DCR (Dynamic Client Registration):** POST `/oauth/register` with JSON payload `{"client_name":"local","redirect_uris":["http://127.0.0.1:8123/cb"],"grant_types":["authorization_code","refresh_token"]}` returns a `client_id`.

### Authorization Flow

- [ ] **Authorization endpoint:** `/oauth/authorize?client_id=…&redirect_uri=http://127.0.0.1:8123/cb&response_type=code&code_challenge=<S256>&code_challenge_method=S256&state=abc&scope=primer` in a browser (logged into Primer) shows the consent form.
- [ ] **Consent form CSRF:** POST `/oauth/consent` with the approval returns a `code` in a redirect.

### Token Exchange

- [ ] **Token endpoint:** POST `/oauth/token` with code + verifier returns `access_token`, `refresh_token`, `expires_in`, `scope`.
- [ ] **Bearer authorization:** `curl -sX POST http://localhost:3000/mcp -H "Authorization: Bearer <access_token>" ...` returns a valid MCP response (e.g., `tools/list` returns 7 tools).

### Token Rotation & Reuse Detection

- [ ] **Refresh flow:** POST `/oauth/token` with `grant_type=refresh_token&refresh_token=…` returns a new access + refresh pair, both different from the previous pair.
- [ ] **Reuse detection:** Replay the original refresh token after a new one is issued. Confirm HTTP 400 `invalid_grant`.
- [ ] **Family revocation:** Query `oauth_refresh_tokens` table. Confirm the entire family (`family_id`) of the original refresh token has `revoked_at IS NOT NULL`.

### Revocation

- [ ] **Revoke endpoint:** POST `/oauth/revoke` with a refresh token returns HTTP 200.
- [ ] **Revoked token fails:** Attempt to use the revoked refresh token in a new token exchange. Confirm HTTP 400 `invalid_grant`.

### Device Flow Regression

- [ ] **Device authorization:** From a Claude Code session running `/dev/device/authorize`, receive a `device_code` and `user_code`.
- [ ] **Device token:** Poll `/api/device/token` with the device code; after user logs in via the verification_uri, receive an access token.
- [ ] **Tool invocation:** Use the device-flow access token to call `/mcp` with `tools/list`. Confirm 7 tools.
- [ ] **MCP tools via device flow:** Exercise `primer_whoami`, `primer_get_document`, `primer_list_versions`, `primer_get_comments`, `primer_create_document`, `primer_add_version`, `primer_resolve_url`.

### End-to-End (Claude Web)

- [ ] **Add connector:** In Claude Web (public URL only), add the Primer connector at the deployed `<issuer>` URL.
- [ ] **Authorize:** Complete the OAuth flow in Claude Web. Note the exact `redirect_uri` Claude Web advertises at DCR time.
- [ ] **Invoke tools:** From a Claude Web conversation, call one or more of the seven MCP tools.
- [ ] **Verify redirect_uri:** If the actual `redirect_uri` from Claude Web differs from the entry in `REDIRECT_URI_ALLOWLIST` below, note it for adjustment.

---

## Redirect-URI Allowlist

**Current constant** in `apps/api/src/auth/oauth/clients.ts`:

```typescript
export const REDIRECT_URI_ALLOWLIST: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
] as const;
```

**Loopback URIs (automatic):** All `http://127.0.0.1:<any port>` URIs are automatically allowed for local development and testing.

**Note:** The exact `redirect_uri` that Claude Web or Claude Desktop advertise at OAuth DCR time may differ from the hardcoded entry (e.g., due to deployment-specific hostnames, staging vs. production, or different desktop client versions). After manual verification in Step 5, if a discrepancy is found, the maintainer should:

1. Update `REDIRECT_URI_ALLOWLIST` in `apps/api/src/auth/oauth/clients.ts`.
2. Add or update a test asserting the new allowed URI.
3. Commit and redeploy.

---

## PUBLIC_PATHS & Well-Known Endpoints

**Verified in `apps/api/src/middleware/auth.ts`:**

The `PUBLIC_PATHS` set includes:
- ✓ `/api/health` (existing)
- ✓ `/auth/login` (existing)
- ✓ `/auth/callback` (existing)
- ✓ `/api/device/authorize` (existing)
- ✓ `/api/device/token` (existing)
- ✓ `/oauth/register` (new)
- ✓ `/oauth/authorize` (new)
- ✓ `/oauth/consent` (new)
- ✓ `/oauth/token` (new)
- ✓ `/oauth/revoke` (new)

**Well-known OAuth metadata endpoints** (automatically handled by `isPublicWellKnown()` check):
- ✓ `/.well-known/oauth-authorization-server`
- ✓ `/.well-known/oauth-protected-resource`

All expected OAuth endpoints and well-known paths are protected from the auth middleware and can be accessed by unauthenticated clients.

---

## Environment Documentation

**Updated:** `.env.example`

Added documentation for the new `OAUTH_ISSUER` environment variable:

```env
# OAuth 2.1 (required for remote MCP access via /mcp endpoint)
# OAUTH_ISSUER=http://localhost:3000  # Set to the API base URL when enabling OAuth
# The OAuth 2.1 endpoint will serve metadata at /.well-known/oauth-authorization-server
# and /.well-known/oauth-protected-resource
```

---

## Summary

✓ **Typecheck:** All packages pass  
✓ **API regression:** 442/442 tests pass (53 test files)  
✓ **MCP regression:** 100/100 tests pass (5 test files)  
✓ **Public paths:** All OAuth endpoints + well-known metadata routes are correctly exposed  
✓ **Env docs:** `OAUTH_ISSUER` documented in `.env.example`  
✓ **Redirect-URI allowlist:** Current state documented; ready for manual verification and adjustment

**Next steps:** Perform the manual verification checklist (Step 5) against a running instance, then update `REDIRECT_URI_ALLOWLIST` if real client URIs differ, and deploy.
