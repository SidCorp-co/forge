import type { ConnectionDirectoryStatus } from '@forge/contracts/integrations';
import { HTTPException } from 'hono/http-exception';
import type { BindingRole } from '../db/schema.js';
import type { AgentAccess } from './agent-access.js';
import { bindingNames } from './binding-name.js';
import { raceWithTimeout } from './probe.js';
import { getAdapter, getIntegration } from './registry.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  effectiveConfig,
  type IntegrationBindingRow,
  type IntegrationConnectionRow,
} from './store.js';
import type { HealthCheckResult, IntegrationAdapterMethods, IntegrationProvider } from './types.js';
import { isVaultConfigured } from './vault.js';

export function assertVaultConfigured(): void {
  if (!isVaultConfigured()) {
    throw new HTTPException(503, {
      message:
        'integration vault is not configured — set INTEGRATION_MASTER_KEY on the core server (openssl rand -base64 32) and restart',
      cause: { code: 'VAULT_NOT_CONFIGURED' },
    });
  }
}

export const notFound = (entity = 'integration') =>
  new HTTPException(404, { message: `${entity} not found`, cause: { code: 'NOT_FOUND' } });

const BINDING_DOOR =
  'PUT /api/projects/:projectId/bindings/:bindingId { baseRevision, document } (a binding-v1 document), and switched off only through DELETE /api/projects/:projectId/bindings/:bindingId { baseRevision }';

export function bindingWriteMoved(what: string): HTTPException {
  return new HTTPException(410, {
    message: `${what} no longer writes a binding: a binding is written only through ${BINDING_DOOR}. A connection is created with POST /api/integration-connections and named in the document's \`connection\`.`,
    cause: { code: 'BINDING_WRITE_MOVED' },
  });
}

export function adapterOrRefuse(provider: string): IntegrationAdapterMethods {
  const adapter = getAdapter(provider);
  if (!adapter) {
    throw new HTTPException(400, {
      message: `no adapter registered for provider=${provider}`,
      cause: { code: 'NO_ADAPTER' },
    });
  }
  return adapter;
}

export function notifyConnectionChanged(provider: string, connectionId: string): void {
  getAdapter(provider)?.onConnectionChanged?.(connectionId);
}

export function summarizeBinding(pair: BindingWithConnection) {
  const { binding, connection } = pair;
  return {
    id: binding.id,
    connectionId: connection.id,
    projectId: binding.projectId,
    provider: binding.provider as IntegrationProvider,
    role: binding.role as BindingRole,
    config: effectiveConfig(pair),
    bindingConfig: (binding.config ?? {}) as Record<string, unknown>,
    label: binding.label ?? '',
    active: binding.active && connection.active,
    bindingActive: binding.active,
    connectionActive: connection.active,
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthDetail: connection.lastHealthDetail,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    hasSecrets: connection.secretsEnc !== null,
    integrationSecretSet: binding.integrationSecretEnc !== null,
    agentAccess: binding.agentAccess as AgentAccess,
    agentPathKind: getIntegration(binding.provider)?.capabilities.agentPath.kind ?? 'none',
    revision: binding.revision,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

/** Owner-facing connection summary (never echoes secret bytes). */
/**
 * The one rule that buckets a connection's raw health for display: the connections directory reads
 * it off the summary, and the project status cards fold it into their coarser card status.
 */
export function connectionHealthStatus(h: {
  active: boolean;
  lastHealthStatus: string | null;
  breakerOpenedAt: Date | null;
}): ConnectionDirectoryStatus {
  if (!h.active) return 'disabled';
  const s = h.lastHealthStatus?.toLowerCase() ?? null;
  if (s === 'needs_reauth' || s === 'needs_scope') return s;
  if (h.breakerOpenedAt !== null) return 'degraded';
  // Active but never health-checked: no signal is not the same as degraded.
  if (!s) return 'unverified';
  if (s === 'ok' || s === 'healthy' || s === 'success') return 'connected';
  if (s === 'degraded' || s === 'pending' || s === 'unknown') return 'degraded';
  return 'error';
}

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
    lastHealthDetail: connection.lastHealthDetail,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    directoryStatus: connectionHealthStatus(connection),
    hasSecrets: connection.secretsEnc !== null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * The directory projection: the credential plus where it is used. Kept apart
 * from `summarizeConnection` on purpose — create and update answer with the
 * bare summary and have no usage to report, so widening the shared projection
 * would buy them a join for a field they never fill.
 */
export function summarizeConnectionWithUsage(
  connection: IntegrationConnectionRow,
  bindings: IntegrationBindingRow[],
  /** Binding id → the project-document environment that deploys through it, where one does. */
  environmentOf: (binding: IntegrationBindingRow) => string | null,
  /** Binding id → the name its provider reports for what it points at (`reportedBindingIdentities`). */
  reported?: ReadonlyMap<string, string>,
) {
  const names = new Map<string, string>();
  const byProject = new Map<string, IntegrationBindingRow[]>();
  for (const b of bindings) byProject.set(b.projectId, [...(byProject.get(b.projectId) ?? []), b]);
  for (const rows of byProject.values()) {
    const named = bindingNames(
      rows.map((binding) => ({
        id: binding.id,
        provider: binding.provider,
        role: binding.role,
        environment: environmentOf(binding),
        label: binding.label ?? '',
        config: effectiveConfig({ binding, connection }),
      })),
      reported,
    );
    for (const [id, name] of named) names.set(id, name);
  }
  return {
    ...summarizeConnection(connection),
    usage: {
      bindings: bindings.map((b) => ({
        id: b.id,
        projectId: b.projectId,
        role: b.role as BindingRole,
        label: b.label,
        name: names.get(b.id) ?? b.role,
        active: b.active,
      })),
    },
  };
}

function hostOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function str(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A name for a connection its owner will recognise, from the non-secret config
 * they just typed. Returns null when the config says nothing distinguishing —
 * an honest null the caller falls back on, never a fabricated detail.
 */
export function defaultConnectionDisplayName(
  provider: IntegrationProvider,
  config: Record<string, unknown>,
): string | null {
  const detail =
    hostOf(config.baseUrl) ??
    hostOf(config.endpoint) ??
    str(config, 'workspaceName') ??
    str(config, 'storeSlug') ??
    str(config, 'org') ??
    str(config, 'organization') ??
    hostOf(config.url);
  return detail ? `${provider} · ${detail}` : null;
}

/** The create/bind 201 must not hang on a slow provider — past this the
 *  response returns `health: null` and the probe result lands via the
 *  adapter's own write + the next refetch (ISS-431). */
const INITIAL_PROBE_TIMEOUT_MS = 5_000;

/** Cap for the explicit connection Test (ISS-435) — matches the health
 *  sweep's per-probe budget. */
export const TEST_PROBE_TIMEOUT_MS = 10_000;

export async function runInitialHealthcheck(
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

export function toIso(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}
