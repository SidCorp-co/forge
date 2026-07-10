/**
 * Shared helpers for the integrations route modules — the project-scoped
 * router (`routes.ts`) and the owner-scoped connection router
 * (`connection-routes.ts`) both import from here (never from each other, so
 * there is no module cycle): auth guards, HTTP error constructors, response
 * projections, and the shared tail of the two binding-creating endpoints.
 */

import { HTTPException } from 'hono/http-exception';
import type { IntegrationEnvironment } from '../db/schema.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { raceWithTimeout } from './probe.js';
import { getAdapter } from './registry.js';
import {
  type BindingWithConnection,
  type IntegrationConnectionRow,
  buildContextFromBinding,
  effectiveConfig,
  findActiveBinding,
  findBindingWithConnectionById,
} from './store.js';
import type { HealthCheckResult, IntegrationProvider } from './types.js';
import { isVaultConfigured } from './vault.js';

// `assertVaultBootSafety` lets core boot when the integration tables are empty,
// so the first create/update attempt is the moment the missing-key
// misconfiguration surfaces. Convert it into a structured 503 so operators see
// a remediation message instead of a bare "Internal Server Error".
export function assertVaultConfigured(): void {
  if (!isVaultConfigured()) {
    throw new HTTPException(503, {
      message:
        'integration vault is not configured — set INTEGRATION_MASTER_KEY on the core server (openssl rand -base64 32) and restart',
      cause: { code: 'VAULT_NOT_CONFIGURED' },
    });
  }
}

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
export const forbidden = () =>
  new HTTPException(403, { message: 'forbidden', cause: { code: 'FORBIDDEN' } });
export const notFound = (entity = 'integration') =>
  new HTTPException(404, { message: `${entity} not found`, cause: { code: 'NOT_FOUND' } });

/** 409 for the one-active-binding-per-slot invariant (create + bind-existing). */
export const alreadyExists = (
  message = 'integration already exists for this provider+environment',
) => new HTTPException(409, { message, cause: { code: 'ALREADY_EXISTS' } });

/**
 * Shared pre-check of the two binding-creating endpoints: one active binding
 * per (project, provider, environment) — 409 ALREADY_EXISTS on a clash.
 * (Epodsystem creates check by label instead — see the create route.)
 */
export async function assertNoActiveBindingClash(
  projectId: string,
  provider: IntegrationProvider,
  environment: IntegrationEnvironment,
): Promise<void> {
  const clash = await findActiveBinding(projectId, provider, environment);
  if (clash) throw alreadyExists();
}

/** ISS-609 — apply rocketchat connection/binding CRUD to the live bot socket
 *  (dial / teardown / re-subscribe) without a core restart. Fire-and-forget;
 *  goes via pg NOTIFY so the instance owning the socket reloads even when it
 *  isn't the one that served this request. Lazily imported: the connection
 *  manager reads env at module scope, and this fire-and-forget hop is the
 *  routers' only dependency on it. */
export function reloadRocketChatIfNeeded(provider: string, connectionId: string): void {
  if (provider !== 'rocketchat') return;
  void import('./rocketchat/connection-manager.js')
    .then((m) => m.requestRocketChatReload(connectionId))
    .catch(() => {});
}

export async function assertProjectMember(
  projectId: string,
  userId: string,
): Promise<'admin' | 'member' | 'viewer'> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw notFound('project');
  if (!access.role) throw forbidden();
  return access.role;
}

export function assertAdmin(role: 'admin' | 'member' | 'viewer'): void {
  if (role !== 'admin') throw forbidden();
}

/**
 * Project-facing integration summary, projected from a binding + its owning
 * connection. Field names are kept stable for the web client: `id` is the
 * BINDING id (== old project_integration id for backfilled rows); health/breaker
 * + secret-presence come from the connection; `config` is the effective overlay.
 */
export function summarizeBinding(pair: BindingWithConnection) {
  const { binding, connection } = pair;
  return {
    id: binding.id,
    connectionId: connection.id,
    projectId: binding.projectId,
    provider: binding.provider as IntegrationProvider,
    environment: binding.environment as IntegrationEnvironment,
    config: effectiveConfig(pair),
    // Raw binding-tier overrides so clients can tell a per-project value from
    // one inherited off the shared connection (`config` is the merged view).
    bindingConfig: (binding.config ?? {}) as Record<string, unknown>,
    // ISS-558 — empty string = default/unlabeled; non-empty = named store.
    label: binding.label ?? '',
    active: binding.active && connection.active,
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    hasSecrets: connection.secretsEnc !== null,
    integrationSecretSet: binding.integrationSecret !== null,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

/** Owner-facing connection summary (never echoes secret bytes). */
export function summarizeConnection(connection: IntegrationConnectionRow) {
  return {
    id: connection.id,
    ownerType: connection.ownerType,
    ownerId: connection.ownerId,
    provider: connection.provider as IntegrationProvider,
    displayName: connection.displayName,
    config: connection.config,
    active: connection.active,
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    hasSecrets: connection.secretsEnc !== null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Broadcast a binding mutation to the project room so web clients refresh the
 * integrations list/status + connections cache live (ISS-401/C). Fire-and-
 * forget — never let a publish failure surface on the mutation response. Only
 * binding mutations carry a `projectId`; owner-scoped connection mutations have
 * no project room and rely on client self-invalidation + reconnect replay.
 */
export function broadcastIntegrationChanged(
  projectId: string,
  extra: { bindingId?: string; connectionId?: string } = {},
): void {
  try {
    roomManager.publish(projectRoom(projectId), {
      event: 'integration.changed',
      data: { projectId, ...extra },
    });
  } catch {
    // Realtime is best-effort; window-focus refetch + reconnect replay backstop.
  }
}

/** The create/bind 201 must not hang on a slow provider — past this the
 *  response returns `health: null` and the probe result lands via the
 *  adapter's own write + the next refetch (ISS-431). */
const INITIAL_PROBE_TIMEOUT_MS = 5_000;

/** Cap for the explicit connection Test (ISS-435) — matches the health
 *  sweep's per-probe budget. */
export const TEST_PROBE_TIMEOUT_MS = 10_000;

/**
 * Best-effort immediate healthcheck after a binding is created or bound
 * (ISS-429): the operator gets a REAL health state right away instead of an
 * `unverified` card until someone presses Test. Adapter healthchecks persist
 * health onto the connection (epodsystem additionally fills store identity
 * into config), so callers should re-read the pair afterwards. Never throws —
 * a failed probe is a valid result, and a crashed probe must not undo a
 * successful create. Time-boxed: the adapter keeps running past the deadline
 * (its result still persists), only the response stops waiting.
 */
async function runInitialHealthcheck(
  pair: BindingWithConnection,
): Promise<HealthCheckResult | null> {
  const adapter = getAdapter(pair.binding.provider);
  if (!adapter) return null;
  try {
    return await raceWithTimeout(
      adapter.healthcheck(buildContextFromBinding(pair)),
      INITIAL_PROBE_TIMEOUT_MS,
    );
  } catch {
    // The adapter records its own failure states; a transport-level crash here
    // simply leaves the connection `unverified`.
    return null;
  }
}

/**
 * Shared tail of the two binding-creating endpoints (create + bind-existing,
 * ISS-429/431): immediate probe, re-read for fresh health/config (the probe
 * mutates the connection), broadcast, and the 201 payload.
 */
export async function buildCreatedBindingResponse(
  pair: BindingWithConnection,
  integrationSecret: string,
): Promise<{
  integration: ReturnType<typeof summarizeBinding>;
  integrationSecret: string;
  health: HealthCheckResult | null;
}> {
  const health = await runInitialHealthcheck(pair);
  let refreshed: BindingWithConnection | null | undefined;
  try {
    refreshed = await findBindingWithConnectionById(pair.binding.id);
  } catch {
    refreshed = null;
  }
  broadcastIntegrationChanged(pair.binding.projectId, {
    bindingId: pair.binding.id,
    connectionId: pair.connection.id,
  });
  return { integration: summarizeBinding(refreshed ?? pair), integrationSecret, health };
}

export function toIso(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}
