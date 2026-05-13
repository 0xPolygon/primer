-- Runs once on first Postgres boot (mounted into /docker-entrypoint-initdb.d/).
-- Creates the separate test database called for by the design spec.
CREATE DATABASE primer_test OWNER primer;
