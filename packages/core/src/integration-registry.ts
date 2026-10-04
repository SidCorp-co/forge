import { autoflowIntegration } from './integrations/autoflow/index.js';
import { coolifyIntegration } from './integrations/deploy/index.js';
import { epodsystemIntegration } from './integrations/epodsystem/index.js';
import { githubIntegration } from './integrations/github/index.js';
import { gitlabIntegration } from './integrations/gitlab/index.js';
import {
  agentIntegration,
  type IntegrationDeclaration,
  isRegistered,
  registerIntegration,
} from './integrations/index.js';
import { rocketchatIntegration } from './integrations/rocketchat/index.js';
import { sentryIntegration } from './integrations/sentry/index.js';

const ALL: readonly IntegrationDeclaration[] = [
  coolifyIntegration as IntegrationDeclaration,
  epodsystemIntegration as IntegrationDeclaration,
  sentryIntegration as IntegrationDeclaration,
  rocketchatIntegration as IntegrationDeclaration,
  githubIntegration as IntegrationDeclaration,
  gitlabIntegration as IntegrationDeclaration,
  agentIntegration,
  autoflowIntegration as IntegrationDeclaration,
];

/**
 * Every project-bound integration, registered once at boot. The vendors sit under the integrations
 * port and import it, so the list lives here rather than on the port. Idempotent, so a test that
 * calls it twice does not throw on the already-declared guard.
 */
export function registerAllIntegrations(): void {
  for (const decl of ALL) {
    if (isRegistered(decl.provider)) continue;
    registerIntegration(decl);
  }
}
