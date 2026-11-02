/**
 * What every route on the source door shares: the grant it asks for and the host it reaches. Split
 * out so the change-request routes and the projection routes stand on one copy of each.
 */

import type { IntegrationRefusalCode } from '@forge/contracts/integrations';
import type { Hono, MiddlewareHandler } from 'hono';
import {
  resolveSourceHost,
  type SourceHost,
  SourceHostCallError,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
import { refuser } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { requiresOnParam } from '../permissions/index.js';

export const refuse = refuser<IntegrationRefusalCode>('INTEGRATION_REFUSED');

export type Routes = Hono<{ Variables: AuthVars }>;

/** The permission a source-door route declares on the project its `:projectId` names. */
export const can = (level: 'project.read' | 'project.write'): MiddlewareHandler =>
  requiresOnParam(level, 'projectId');

/**
 * The project's source host for an agent, then the call. A binding that is missing, switched off,
 * on another host or not granted to agents is refused by name, and so is the host failing: a retry
 * of HOST_UNAVAILABLE may succeed.
 */
export async function onHost<T>(
  projectId: string,
  call: (host: SourceHost) => Promise<T>,
): Promise<T> {
  try {
    return await call(await resolveSourceHost(projectId, 'agent'));
  } catch (err) {
    if (err instanceof SourceHostUnavailable) {
      throw refuse('SOURCE_HOST_UNAVAILABLE', `${err.message} (${err.reason})`);
    }
    if (err instanceof SourceHostCallError) {
      const said = err.detail ? ` The host said: ${err.detail}` : '';
      throw refuse('HOST_UNAVAILABLE', `${err.message}.${said}`);
    }
    throw err;
  }
}
