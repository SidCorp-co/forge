import type { ConnectionAccess } from '@forge/contracts';
import { HTTPException } from 'hono/http-exception';
import type { BindingRole, DeployStage } from '../db/schema.js';
import { effectiveProjectRole, projectWriteRefusal } from '../lib/authz.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { type AgentAccess, noAgentPathMessage } from './agent-access.js';
import {
  type BindingReader,
  bindingActs,
  bindingReaderOf,
  type ProjectRole,
  WHO_CHANGES,
} from './binding-acts.js';
import { checkBindingHealth } from './binding-health.js';
import { healthAnswer } from './health-words.js';
import {
  holdsKey,
  isRemovedConnection,
  keyIn,
  listBoundProjectOrgs,
  type RemovedReader,
  turnsBackOnFrom,
} from './held-key.js';
import { raceWithTimeout } from './probe.js';
import { getAdapter, getIntegration } from './registry.js';
import {
  type BindingWithConnection,
  effectiveConfig,
  findActiveServiceBindingAtLabel,
  findBindingWithConnectionById,
  type IntegrationBindingRow,
  type IntegrationConnectionRow,
} from './store.js';
import type { HealthCheckResult, IntegrationProvider } from './types.js';
import { isVaultConfigured } from './vault.js';
import { notThisProjectsAdmin } from './who-may-refusals.js';

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

/**
 * A connection the caller does not reach, which is also a connection that does not exist — one
 * sentence for both, so the refusal does not say which. Its OWN code rather than `NOT_FOUND`: the
 * web prints one generic phrase for that code and drops the server's, so a sentence naming the
 * subject and the way round never reached a screen that way (ISS-1216).
 */
export const connectionNotReachable = (connectionId: string) =>
  new HTTPException(404, {
    message:
      'This connection is not one you can reach. A connection is visible to the ' +
      'individual who owns it, to the members of the organization that owns it, and to an admin ' +
      "of a project it is bound to. Only its owner (for an organization's connection, an owner or " +
      'admin of that organization) can bind it to a project you administer, so ask them.',
    cause: { code: 'CONNECTION_NOT_REACHABLE', details: { connectionId } },
  });

/** {@link connectionNotReachable} for a delete, naming the usual reason first: a Clear (ISS-1421 r24). */
export const connectionGoneOrNotReachable = (connectionId: string) =>
  new HTTPException(404, {
    message:
      'This connection is already gone, or is not one you can reach. Only its owner ' +
      "(for an organization's connection, an owner or admin of that organization) can delete it.",
    cause: { code: 'CONNECTION_NOT_REACHABLE', details: { connectionId } },
  });

/** {@link turnsBackOnFrom}, reading the connection's bindings only where they decide the sentence. */
export async function turnsBackOn(
  connection: { id: string; provider: string; ownerType: 'user' | 'org'; ownerId: string },
  reader: RemovedReader,
  askedFrom?: string,
): Promise<string> {
  const bound = getIntegration(connection.provider)?.noKeyTurnsBackOn
    ? await listBoundProjectOrgs(connection.id)
    : [];
  return turnsBackOnFrom(connection, bound, reader, askedFrom);
}

/** A person asking about a connection from a project, holding `role` there. */
export type Asker = { userId: string; role: 'admin' | 'member' | 'viewer'; projectId: string };

/** What an asker may do about a removed connection, read off the predicate the doors refuse by (ISS-1421 r27). */
export async function removedReaderOf(
  connection: { id: string; provider: string; ownerType: 'user' | 'org'; ownerId: string },
  asker: Asker,
): Promise<RemovedReader> {
  const reader = await bindingReaderOf(asker.userId, asker.projectId, asker.role);
  const acts = bindingActs(reader, connection, connection.provider);
  return { manages: acts.turnOn, savesKey: acts.saveKey, installsHere: acts.turnOn && acts.change };
}

type RemovedAct = 'shared' | 'tested' | 'turned on for this project' | 'asked for its applications';

/** A binding to a removed connection cannot resolve, and a check of it can only fail (ISS-1421 r22). */
const connectionRemoved = (act: RemovedAct, turnsBack: string) =>
  new HTTPException(409, {
    message: `This connection was removed and holds no key, so it cannot be ${act}. ${turnsBack}`,
    cause: { code: 'CONNECTION_REMOVED' },
  });

/** A key saved between Clear's read and its delete keeps the connection, and Clear says so. */
export const connectionChangedWhileCleared = () =>
  new HTTPException(409, {
    message:
      'This connection changed while it was being cleared: a key was saved on it or it was turned back on, so it was kept. Open it again to see what it holds.',
    cause: { code: 'CONNECTION_CHANGED' },
  });

/** Asked from a project, the refusal answers that project's own page and the asker's role there. */
export async function assertNotRemoved(
  connection: Parameters<typeof isRemovedConnection>[0] & {
    id: string;
    ownerType: 'user' | 'org';
    ownerId: string;
  },
  act: RemovedAct,
  asked: RemovedReader | Asker,
): Promise<void> {
  if (!isRemovedConnection(connection)) return;
  if (!('userId' in asked)) throw connectionRemoved(act, await turnsBackOn(connection, asked));
  const reader = await removedReaderOf(connection, asked);
  throw connectionRemoved(act, await turnsBackOn(connection, reader, asked.projectId));
}

/** Read off the patch as sent, before the org tier: one saving no usable key is answered alike (ISS-1421 r26). */
export async function refuseSwitchOnOverRemoved(
  patch: { active?: boolean | undefined; secrets?: Record<string, unknown> | undefined },
  connection: Parameters<typeof assertNotRemoved>[0],
  asker: Asker,
): Promise<void> {
  if (patch.active !== true) return;
  if (patch.secrets !== undefined && keyIn(connection.provider, patch.secrets)) return;
  await assertNotRemoved(connection, 'turned on for this project', asker);
}

/** A key no check has judged yet: the last check was of a key no longer used (ISS-1421 r21). */
export const NOT_CHECKED = { lastHealthStatus: null, lastHealthDetail: null, lastHealthAt: null };

/**
 * What a saved credential does to the last check, at every door that saves one (ISS-1259 r2): a new
 * key leaves the connection Not checked yet, and a save carrying no key leaves the check standing.
 */
export function healthOnKeySaved(
  provider: string,
  sent: Record<string, unknown>,
): Partial<typeof NOT_CHECKED> {
  return keyIn(provider, sent) ? NOT_CHECKED : {};
}

/** A key saved from a project reads Not checked yet, and turns a removed connection back on (ISS-1421 r26). */
export function keySavedHere(
  connection: Parameters<typeof isRemovedConnection>[0],
  sent: Record<string, unknown>,
): Partial<typeof NOT_CHECKED & { active: boolean }> {
  const health = healthOnKeySaved(connection.provider, sent);
  if (!keyIn(connection.provider, sent) || !isRemovedConnection(connection)) return health;
  return { ...health, active: true };
}

/** A grant asked of a provider that declares no agent path: no one may take it, whoever asks. */
export const noAgentPath = (provider: string) => badRequest(noAgentPathMessage(provider));

/** `stages` say where a deploy binding sends code; the DB check holds any other role at none. */
export const stagesOnNonDeployBinding = (role: string) =>
  new HTTPException(400, {
    message: `stages say where a deploy binding sends code; this binding's role is \`${role}\`, which sends none. Change the role, or leave stages off this patch.`,
    cause: { code: 'STAGES_ON_NON_DEPLOY_BINDING', details: { role } },
  });

/** 409 for the one-active-service-binding invariant (create + bind-existing). */
export const alreadyExists = (
  message = 'an active service binding for this provider already exists on this project',
) => new HTTPException(409, { message, cause: { code: 'ALREADY_EXISTS' } });

/**
 * Shared pre-check of the two binding-creating endpoints: one active SERVICE binding per
 * (project, provider) — 409 ALREADY_EXISTS on a clash. (Epodsystem creates check by label
 * instead — see the create route.)
 */
export async function assertNoActiveBindingClash(
  projectId: string,
  provider: IntegrationProvider,
  role: BindingRole,
  label = '',
): Promise<void> {
  if (role !== 'service') return;
  const clash = await findActiveServiceBindingAtLabel(projectId, provider, label);
  if (clash)
    throw alreadyExists(
      label ? `integration already exists for this provider (label "${label}")` : undefined,
    );
}

/**
 * Tell a provider its connection changed, where the provider declares that it cares.
 *
 * Rocket.Chat is the only one today — it holds a realtime socket that must be rebuilt against the
 * new credential — but this names no provider: the hook is an adapter method, so the next provider
 * with a live process declares it in its own directory and this helper is not edited at all.
 */
export function notifyConnectionChanged(provider: string, connectionId: string): void {
  getAdapter(provider)?.onConnectionChanged?.(connectionId);
}

export async function assertProjectMember(
  projectId: string,
  userId: string,
): Promise<'admin' | 'member' | 'viewer'> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw notFound('project');
  if (!access.role) {
    throw new HTTPException(403, {
      message: `You are not a member of this project, so its integrations are not yours to read or change. Ask ${WHO_CHANGES} to add you.`,
      cause: { code: 'FORBIDDEN' },
    });
  }
  return access.role;
}

/**
 * A write on a project's integrations needs the member role; a viewer reads and is refused here by
 * name. `act` completes "you cannot …", as `assertAdmin`'s does.
 */
export async function assertProjectWriter(
  projectId: string,
  userId: string,
  act: string,
): Promise<'admin' | 'member'> {
  const role = await assertProjectMember(projectId, userId);
  if (role === 'viewer') {
    throw new HTTPException(403, {
      message: projectWriteRefusal(role, act),
      cause: { code: 'FORBIDDEN' },
    });
  }
  return role;
}

/** `act` completes "you cannot …": what the reader asked to do, said as they would say it. */
export function assertAdmin(role: ProjectRole, act: string): void {
  if (role !== 'admin') throw notThisProjectsAdmin(role, act);
}

/** {@link summarizeBinding} as a project's own list reads it: with what this reader may do (ISS-1421 r27). */
export function summarizeProjectBinding(pair: BindingWithConnection, reader: BindingReader) {
  return {
    ...summarizeBinding(pair),
    acts: bindingActs(reader, pair.connection, pair.binding.provider),
  };
}

export function summarizeBinding(pair: BindingWithConnection) {
  const { binding, connection } = pair;
  return {
    id: binding.id,
    connectionId: connection.id,
    projectId: binding.projectId,
    provider: binding.provider as IntegrationProvider,
    role: binding.role as BindingRole,
    stages: (binding.stages ?? []) as DeployStage[],
    config: effectiveConfig(pair),
    bindingConfig: (binding.config ?? {}) as Record<string, unknown>,
    label: binding.label ?? '',
    active: binding.active && connection.active,
    bindingActive: binding.active,
    connectionActive: connection.active,
    lastHealthStatus: connection.lastHealthStatus,
    lastHealthAt: connection.lastHealthAt,
    breakerOpenedAt: connection.breakerOpenedAt,
    hasSecrets: holdsKey(connection),
    integrationSecretSet: binding.integrationSecret !== null,
    agentAccess: binding.agentAccess as AgentAccess,
    agentPathKind: getIntegration(binding.provider)?.capabilities.agentPath.kind ?? 'none',
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
    hasSecrets: holdsKey(connection),
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
  access: ConnectionAccess,
) {
  return {
    ...summarizeConnection(connection),
    access,
    usage: {
      bindings: bindings.map((b) => ({
        id: b.id,
        projectId: b.projectId,
        role: b.role as BindingRole,
        stages: (b.stages ?? []) as DeployStage[],
        label: b.label,
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
export function defaultConnectionDisplayName(config: Record<string, unknown>): string | null {
  const detail =
    hostOf(config.baseUrl) ??
    hostOf(config.endpoint) ??
    str(config, 'workspaceName') ??
    str(config, 'storeSlug') ??
    str(config, 'org') ??
    str(config, 'organization') ??
    hostOf(config.url);
  return detail;
}

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

async function runInitialHealthcheck(
  pair: BindingWithConnection,
): Promise<HealthCheckResult | null> {
  const adapter = getAdapter(pair.binding.provider);
  if (!adapter) return null;
  try {
    const result = await raceWithTimeout(
      checkBindingHealth(adapter, pair),
      INITIAL_PROBE_TIMEOUT_MS,
    );
    return result && healthAnswer(pair.binding.provider, result);
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
  reader: BindingReader,
): Promise<{
  integration: ReturnType<typeof summarizeProjectBinding>;
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
  return {
    integration: summarizeProjectBinding(refreshed ?? pair, reader),
    integrationSecret,
    health,
  };
}

export function toIso(d: Date | string | null): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : d;
}
