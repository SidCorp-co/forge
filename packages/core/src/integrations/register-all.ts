/**
 * Populates the registry. One call, so a test, a checker and the app all get the same vocabulary.
 *
 * Before ISS-1071 this was seven `register<Provider>Adapter()` calls in `index.ts`, each guarded by
 * its own `if (getAdapter(...)) return;` — which meant a conformance checker that wanted to walk the
 * declarations had to boot the app, and a provider added without its line in `index.ts` was simply
 * absent with nothing reporting it.
 */

import { agentIntegration } from './agent-declaration.js';
import { coolifyIntegration } from './coolify/adapter.js';
import { epodsystemIntegration } from './epodsystem/adapter.js';
import { githubIntegration } from './github/adapter.js';
import { googleIntegration } from './google/adapter.js';
import { postmanIntegration } from './postman/adapter.js';
import { getIntegration, registerIntegration } from './registry.js';
import { rocketchatIntegration } from './rocketchat/adapter.js';
import { sentryIntegration } from './sentry/adapter.js';
import type { IntegrationDeclaration } from './types.js';

// cm:guard this ORDER is the order status cards come back in, because `buildIntegrationsStatusCards`
// walks the registry rather than listing providers. It is the order the six hand-written blocks were
// in before ISS-1071, kept so an existing screen's card sequence does not move under it.
const ALL: readonly IntegrationDeclaration[] = [
  coolifyIntegration as IntegrationDeclaration,
  postmanIntegration as IntegrationDeclaration,
  epodsystemIntegration as IntegrationDeclaration,
  sentryIntegration as IntegrationDeclaration,
  googleIntegration as IntegrationDeclaration,
  rocketchatIntegration as IntegrationDeclaration,
  githubIntegration as IntegrationDeclaration,
  agentIntegration,
];

/** Idempotent, so a test that calls it twice does not throw on the already-declared guard. */
export function registerAllIntegrations(): void {
  for (const decl of ALL) {
    if (getIntegration(decl.provider)) continue;
    registerIntegration(decl);
  }
}
