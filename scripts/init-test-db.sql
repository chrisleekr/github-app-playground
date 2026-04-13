-- Create the test database used by integration tests (test/db/migrate.test.ts).
-- Mounted via docker-compose.dev.yml into /docker-entrypoint-initdb.d/
-- so it runs automatically on first container start.
CREATE DATABASE github_app_test OWNER bot;
