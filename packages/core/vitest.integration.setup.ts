/**
 * What `src/index.ts` does at boot, for the integration suite: fill the integration registry.
 *
 * ISS-1071 — a registry read on an EMPTY registry throws rather than answering "no providers are
 * declared", because those two are indistinguishable to a caller and the second one silently turns
 * every generic path into a no-op. Production registers in `src/index.ts`; these tests build the
 * app from its route modules rather than from that file, so nothing here had ever registered and
 * 66 of them died on the throw the moment it existed.
 *
 * It belongs in the suite's own setup rather than in each file because an integration test reaches
 * the registry THROUGH the app — a webhook, a dispatch, a prompt — so which files need it is not
 * a property anyone can read off an import list, and the answer changes as routes move.
 *
 * Deliberately NOT done for the unit suite (`vitest.setup.ts`): `integrations/registry.test.ts`
 * asserts the empty-registry throw for every derived read, and a global registration there would
 * turn the tests that prove that contract into ones that cannot fail.
 */

import { beforeAll } from 'vitest';

// The import is INSIDE the hook, and that is load-bearing. Filling the registry imports all eight
// adapters, and `config/env.ts` validates the environment at module load — but the integration
// suite's real DATABASE_URL is set by `tests/helpers/db.ts` when a test file imports it, which is
// after this file is evaluated. Registering at the top level therefore ran the validator against
// an environment nobody had built yet and failed every file with `Invalid environment` instead.
beforeAll(async () => {
  const { registerAllIntegrations } = await import('./src/integrations/register-all.js');
  registerAllIntegrations();
});
