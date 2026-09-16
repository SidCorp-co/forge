/**
 * What `src/index.ts` does at boot: fill the integration registry.
 *
 * ISS-1071 — a read of an EMPTY registry throws rather than answering "no providers are declared",
 * because those two are indistinguishable to a caller and the second silently turns every generic
 * path into a no-op. Files that go through `startTestServer` already register, because that imports
 * `src/index.js` — the real boot path. The ones that build the app from its own route modules have
 * to say so themselves.
 *
 * It lives in `helpers/` rather than being imported directly by each test for two reasons: the
 * registration is one decision, in one place, if it ever needs to change; and a test file importing
 * `src/integrations/register-all.js` for itself gains an edge to `core-integrations`, which pushed
 * `per-state-override-e2e.test.ts` to seven modules against archmap's `no-coordinator-blob` limit
 * of six — a fan-out violation earned by a line that has nothing to do with what the file tests.
 *
 * The import is INSIDE the function: filling the registry imports all eight adapters, and
 * `config/env.ts` validates the environment at module load, so a top-level import would run that
 * validator before the caller has set `process.env.DATABASE_URL`.
 */
export async function registerIntegrationsForTest(): Promise<void> {
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
}
