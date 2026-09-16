/**
 * Unit-test environment floor.
 *
 * `src/config/env.ts` validates at MODULE LOAD and throws when the three required variables are
 * absent. That was tolerable while only a handful of unit tests reached a module that imports it;
 * ISS-1071 made the integration registry the thing every generic path asks, and filling it imports
 * all eight adapters, several of which reach the queue and the db client. A test whose subject is a
 * pure function now pays that import, so without this floor eleven unrelated files would each carry
 * their own copy of the same `vi.mock('../config/env.js', ...)` block — eleven places to edit when a
 * required variable is added, and eleven chances for one of them to drift into asserting against a
 * shape the real env no longer has.
 *
 * These are placeholders, not configuration. Nothing here reaches a real service: the unit suite
 * mocks `db/client.js`, and a test that genuinely needs Postgres lives under `tests/integration/`
 * with its own `globalSetup` and a real `TEST_DATABASE_URL`.
 */
// cm:guard `??=`, never `=`. A test that sets one of these DELIBERATELY — `config/env.test.ts`
// plants `DATABASE_URL = 'not-a-url'` to watch the validator refuse it — must keep its own value,
// and an integration run must keep the real `TEST_DATABASE_URL`-derived one. Overwriting here would
// turn the one test that proves the validator works into a test that cannot fail.
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/forge_unit_placeholder';
process.env.JWT_SECRET ??= 'unit-test-placeholder-secret-at-least-32-chars';
process.env.DEVICE_TOKEN_PEPPER ??= 'unit-test-placeholder-pepper-at-least-32-chars';
