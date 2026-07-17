-- Seed the Claude service account. Its API tokens are minted from the
-- admin-gated section of /settings/tokens; actions performed with them are
-- attributed to this user. The id can never collide with an Okta sub, so
-- this account cannot log in interactively.
INSERT INTO users (id, email, display_name)
VALUES ('service-claude', 'claude-service@polygon.technology', 'Claude')
ON CONFLICT (id) DO NOTHING;
