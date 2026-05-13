-- Seed the single mock user used by Phase 1.
-- See sub-project 5 (Auth + ownership) for replacement with real Okta resolution.
INSERT INTO users (id, email, display_name)
VALUES ('mock-user-1', 'mock@polygon.technology', 'Mock User')
ON CONFLICT (id) DO NOTHING;