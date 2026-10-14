import { vi } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/forge_unit_placeholder';
process.env.JWT_SECRET ??= 'unit-test-placeholder-secret-at-least-32-chars';
process.env.DEVICE_TOKEN_PEPPER ??= 'unit-test-placeholder-pepper-at-least-32-chars';

// Unit suites mock the db per subject, so the credential read a comment write makes is answered empty; the integration suite runs it.
vi.mock('./src/comments/credential-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./src/comments/credential-guard.js')>()),
  loadStoredCredentials: async () => [],
  loadCredentialsByIssue: async () => new Map(),
}));
