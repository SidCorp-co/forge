import { vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/forge_unit_placeholder';
process.env.JWT_SECRET ??= 'unit-test-placeholder-secret-at-least-32-chars';
process.env.DEVICE_TOKEN_PEPPER ??= 'unit-test-placeholder-pepper-at-least-32-chars';

// A comment write reads the project's stored test credentials from the database. A unit suite
// mocks the db with the one chain its subject uses and does not model that read, so it is answered
// empty here; `tests/integration/comment-credential-e2e.test.ts` runs the real read.
vi.mock('./src/comments/credential-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./src/comments/credential-guard.js')>()),
  loadStoredCredentials: async () => [],
  loadCredentialsByIssue: async () => new Map(),
}));
