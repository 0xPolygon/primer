-- Seed a SECOND mock user (dev-only multi-user mock auth). Local testing of
-- the live multi-party events relay (issue #78) needs two authenticated
-- collaborators in different browsers at once; with only mock-user-1 every
-- session is the same principal. The id follows the test suite's existing
-- second-persona convention. AUTH_MODE=mock sessions pick a persona via
-- GET /auth/mock (see apps/api/src/routes/mockAuth.ts); production refuses
-- AUTH_MODE=mock at boot, so this row is inert there.
INSERT INTO users (id, email, display_name)
VALUES ('mock-user-2', 'mock-reviewer@polygon.technology', 'Mock Reviewer')
ON CONFLICT (id) DO NOTHING;
