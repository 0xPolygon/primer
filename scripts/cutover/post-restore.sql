-- Run once, right after restoring the Railway backup into the new database and
-- before Primer takes traffic. See docs/runbooks/railway-to-dry-dock-cutover.md.
--
-- The Railway database is presumed read during INC-248. Anything in it that
-- grants access on its own is invalidated here; everyone signs in again and MCP
-- clients re-authorize. Content (documents, versions, comments, folders,
-- collaborators, users) is untouched.
--
-- Idempotent: safe to re-run; a second run changes nothing.

BEGIN;

-- Browser sessions: the session id is the primary key, stored in plaintext, and
-- is exactly the cookie value. Must go.
DELETE FROM sessions;
DELETE FROM external_viewer_sessions;

-- Personal and service API tokens (stored as sha-256 hashes). Revoked rather
-- than deleted so users still see them, marked revoked, on /settings/tokens.
UPDATE api_tokens SET revoked_at = now() WHERE revoked_at IS NULL;

-- OAuth (remote MCP). Access tokens have no revoked flag, so delete them;
-- refresh tokens are revoked. Client registrations and consents are kept:
-- they are not credentials, and re-authorizing still requires an Okta login.
DELETE FROM oauth_access_tokens;
UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
DELETE FROM oauth_authorization_codes WHERE consumed_at IS NULL;

-- In-flight device-flow logins that could still be exchanged for a token.
DELETE FROM device_authorizations WHERE status IN ('pending', 'approved');

-- Outstanding external-viewer one-time codes (6-digit, sha-256 hashed: cheap
-- to brute-force offline from a stolen hash).
UPDATE external_otps SET consumed_at = now() WHERE consumed_at IS NULL;

-- external_shares.share_token is plaintext, but a share link alone does not
-- grant access: the viewer must also pass an emailed OTP as an allowlisted
-- recipient. Links are left working. To rotate them anyway (breaks every link
-- already sent to external recipients), revoke and have owners re-share:
--   UPDATE external_shares SET revoked_at = now() WHERE revoked_at IS NULL;

COMMIT;

-- Post-conditions (all must be 0).
SELECT 'sessions' AS check, count(*) FROM sessions
UNION ALL SELECT 'external_viewer_sessions', count(*) FROM external_viewer_sessions
UNION ALL SELECT 'live api_tokens', count(*) FROM api_tokens WHERE revoked_at IS NULL
UNION ALL SELECT 'oauth_access_tokens', count(*) FROM oauth_access_tokens
UNION ALL SELECT 'live oauth_refresh_tokens', count(*) FROM oauth_refresh_tokens WHERE revoked_at IS NULL
UNION ALL SELECT 'unconsumed oauth_authorization_codes', count(*) FROM oauth_authorization_codes WHERE consumed_at IS NULL
UNION ALL SELECT 'open device_authorizations', count(*) FROM device_authorizations WHERE status IN ('pending', 'approved')
UNION ALL SELECT 'unconsumed external_otps', count(*) FROM external_otps WHERE consumed_at IS NULL;
