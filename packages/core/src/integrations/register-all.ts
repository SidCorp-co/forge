import { agentIntegration } from './agent-declaration.js';
import { coolifyIntegration } from './coolify/adapter.js';
import { epodsystemIntegration } from './epodsystem/adapter.js';
import { githubIntegration } from './github/adapter.js';
import { googleIntegration } from './google/adapter.js';
import { postmanIntegration } from './postman/adapter.js';
import { isRegistered, registerIntegration } from './registry.js';
import { rocketchatIntegration } from './rocketchat/adapter.js';
import { sentryIntegration } from './sentry/adapter.js';
import type { IntegrationDeclaration } from './types.js';

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
    if (isRegistered(decl.provider)) continue;
    registerIntegration(decl);
  }
}
