import { CredentialUnreadable, unreadableHealth } from './credential-unreadable.js';
import { type BindingWithConnection, buildContextFromBinding, updateConnection } from './store.js';
import type { HealthCheckResult, IntegrationAdapterMethods } from './types.js';

/**
 * Check a binding's connection through its adapter. A stored credential this server's key cannot
 * open never reaches the adapter, so the failed check is recorded here, where the adapter would
 * have recorded its own, and the connection reads it until the credential is entered again.
 */
export async function checkBindingHealth(
  adapter: Pick<IntegrationAdapterMethods, 'healthcheck'>,
  pair: BindingWithConnection,
): Promise<HealthCheckResult> {
  let ctx: ReturnType<typeof buildContextFromBinding>;
  try {
    ctx = buildContextFromBinding(pair);
  } catch (err) {
    if (!(err instanceof CredentialUnreadable)) throw err;
    const result = unreadableHealth(err);
    await updateConnection(pair.connection.id, {
      lastHealthStatus: result.status,
      lastHealthDetail: result.message ?? null,
      lastHealthAt: new Date(),
    });
    return result;
  }
  return adapter.healthcheck(ctx);
}
