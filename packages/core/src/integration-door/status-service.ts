import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import {
  type BindingWithConnection,
  effectiveConfig,
  getIntegration,
  type IntegrationCapabilities,
  type IntegrationProvider,
  listBindingsForProject,
  listIntegrations,
  notFound,
  toIso,
} from '../integrations/index.js';
import { hostOfRepository } from '../integrations/source-host/index.js';
import { readDeclaredSource, readDeployMap, webUrlOf } from '../project-config/index.js';

type CardStatus =
  | 'connected'
  | 'attention'
  | 'error'
  | 'not_configured'
  | 'disabled'
  | 'unverified';

export interface StatusCard {
  key: string;
  label: string;
  status: CardStatus;
  detail: string;
  lastSyncAt: string | null;
  configured: boolean;
  meta?: Record<string, unknown>;
}

function healthToStatus(lastHealthStatus: string | null, active: boolean): CardStatus {
  // The binding/connection exists but is switched off — distinct from
  // not_configured (nothing set up at all). ISS-429.
  if (!active) return 'disabled';
  // Active but never health-checked: no signal is not the same as degraded.
  if (!lastHealthStatus) return 'unverified';
  const s = lastHealthStatus.toLowerCase();
  if (s === 'ok' || s === 'healthy' || s === 'success') return 'connected';
  if (s === 'degraded' || s === 'pending' || s === 'unknown') return 'attention';
  if (s === 'needs_reauth' || s === 'needs_scope') return 'attention';
  return 'error';
}

/** Declared capabilities for a provider, for capability-aware card rendering. */
function providerCapabilities(provider: IntegrationProvider): IntegrationCapabilities | null {
  return getIntegration(provider)?.capabilities ?? null;
}

function stageKey(row: { role: string; environment: string | null }): string {
  if (row.role === 'service' || row.role === 'source') return row.role;
  return row.environment ?? 'deploy';
}

/** Flattened binding+connection row the status cards render from. */
interface ProviderRow {
  /** The binding's own id. The one thing about a card that is unique whatever else two
   *  bindings share, and the handle a screen needs to address ONE of them. */
  id: string;
  provider: string;
  role: string;
  /** The project-document environment a deploy binding serves; null where none names it. */
  environment: string | null;
  config: Record<string, unknown>;
  active: boolean;
  lastHealthStatus: string | null;
  /** The sentence behind a non-ok status, where the adapter recorded one. */
  lastHealthDetail?: string | null;
  lastHealthAt: Date | null;
  breakerOpenedAt: Date | null;
}

/**
 * Shared builder for the coolify/epodsystem status cards (ISS-431) —
 * the three blocks were ~95% identical; they differ only in env-keying, the
 * never-checked wording, and provider-specific meta fields.
 */
export function buildProviderCards(opts: {
  rows: ProviderRow[];
  provider: IntegrationProvider;
  label: string;
  /** Coolify is env-split by design, so even a single binding keys by env;
   *  MCP providers keep the bare key unless a second binding appears (keeps
   *  existing drill-ins stable, ISS-429). */
  alwaysEnvKeyed: boolean;
  neverCheckedDetail: string;
  extraMeta?: (row: ProviderRow) => Record<string, unknown>;
}): StatusCard[] {
  const caps = providerCapabilities(opts.provider);
  if (opts.rows.length === 0) {
    return [
      {
        key: opts.provider,
        label: opts.label,
        status: 'not_configured',
        detail: `no ${opts.label} integration configured`,
        lastSyncAt: null,
        configured: false,
        meta: { capabilities: caps },
      },
    ];
  }
  const envKeyed = opts.alwaysEnvKeyed || opts.rows.length > 1;
  const base = (row: ProviderRow) =>
    envKeyed ? `${opts.provider}:${stageKey(row)}` : opts.provider;
  const collides = new Set(opts.rows.map(base).filter((k, i, all) => all.indexOf(k) !== i));
  return opts.rows.map((row) => ({
    key: collides.has(base(row)) ? `${base(row)}:${row.id}` : base(row),
    label: envKeyed ? `${opts.label} (${stageKey(row)})` : opts.label,
    status: healthToStatus(row.lastHealthStatus, row.active),
    detail: !row.active
      ? 'integration disabled'
      : row.lastHealthStatus
        ? `last health: ${row.lastHealthStatus}${row.lastHealthDetail ? ` — ${row.lastHealthDetail}` : ''}`
        : opts.neverCheckedDetail,
    lastSyncAt: toIso(row.lastHealthAt),
    configured: true,
    meta: {
      bindingId: row.id,
      role: row.role,
      environment: row.environment,
      breakerOpen: row.breakerOpenedAt !== null,
      lastHealthStatus: row.lastHealthStatus,
      capabilities: caps,
      ...(opts.extraMeta?.(row) ?? {}),
    },
  }));
}

/**
 * The provider whose binding serves the declared repository's host, oldest active binding first,
 * or null where no source host binding reaches it.
 */
export function repositoryProvider(
  pairs: readonly BindingWithConnection[],
  repository: string | null,
): { provider: string; label: string } | null {
  const host = hostOfRepository(repository);
  if (!host) return null;
  const onHost = pairs
    .flatMap((pair) => {
      const factory = getIntegration(pair.binding.provider)?.sourceHost;
      return factory && factory.hostOf(effectiveConfig(pair)) === host ? [{ pair, factory }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.pair.binding.active && b.pair.connection.active) -
          Number(a.pair.binding.active && a.pair.connection.active) ||
        a.pair.binding.createdAt.getTime() - b.pair.binding.createdAt.getTime(),
    );
  const first = onHost[0];
  return first ? { provider: first.pair.binding.provider, label: first.factory.label } : null;
}

/** Build the full status-card set for a project (caller has already authz'd). */
export async function buildIntegrationsStatusCards(projectId: string): Promise<StatusCard[]> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');

  // One row per active binding, joined to its connection (health/breaker live on
  // the connection). Flattened to the shape the cards below already consume.
  const [pairs, deployMap, source] = await Promise.all([
    listBindingsForProject(projectId),
    readDeployMap(projectId),
    readDeclaredSource(projectId),
  ]);
  const integrationRows = pairs.map((pair) => ({
    id: pair.binding.id,
    provider: pair.binding.provider,
    role: pair.binding.role,
    environment: deployMap.environments.get(pair.binding.id)?.name ?? null,
    config: effectiveConfig(pair),
    active: pair.binding.active && pair.connection.active,
    lastHealthStatus: pair.connection.lastHealthStatus,
    lastHealthDetail: pair.connection.lastHealthDetail,
    lastHealthAt: pair.connection.lastHealthAt,
    breakerOpenedAt: pair.connection.breakerOpenedAt,
  }));

  // Runners bound to this project + each device's git push-cred status.
  const runnerRows = await db
    .select({
      runnerId: runners.id,
      status: runners.status,
      deviceId: runners.deviceId,
      deviceName: devices.name,
      gitCredentialRef: devices.gitCredentialRef,
      lastSeenAt: runners.lastSeenAt,
    })
    .from(runners)
    .leftJoin(devices, eq(devices.id, runners.deviceId))
    .where(eq(runners.projectId, projectId));

  const cards: StatusCard[] = [];

  // --- The repository (+ per-device push-cred), keyed and labelled by the provider its host is ---
  const { repository } = source;
  const host = repositoryProvider(pairs, repository);
  const remoteUrl = repository ? webUrlOf(repository) : null;
  const deviceCreds = runnerRows
    .filter((r) => r.deviceId)
    .map((r) => ({
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      pushCredProvisioned: r.gitCredentialRef !== null,
    }));
  cards.push({
    key: host ? `${host.provider}:repository` : 'repository',
    label: host ? `${host.label} repository` : 'Repository',
    status: repository ? 'connected' : 'not_configured',
    detail: repository
      ? host
        ? repository
        : `${repository} — no source host binding reaches ${hostOfRepository(repository)}`
      : 'the project document declares no repository',
    lastSyncAt: null,
    configured: repository !== null,
    meta: {
      repository,
      remoteUrl,
      baseBranch: source.defaultBranch,
      provider: host?.provider ?? null,
      deviceCreds,
    },
  });

  // One card PER BINDING (ISS-429 — a disabled binding must not shadow an active one), for every
  // provider that declares a presentation, in registry order. Until ISS-1071 this was six
  // hand-written blocks differing only in the four values a declaration now carries, so adding a
  // provider meant editing a file with no other reason to know one existed.
  for (const decl of listIntegrations()) {
    const presentation = decl.presentation;
    if (!presentation) continue;
    cards.push(
      ...buildProviderCards({
        rows: integrationRows.filter((r) => r.provider === decl.provider),
        provider: decl.provider,
        label: presentation.label,
        alwaysEnvKeyed: presentation.alwaysEnvironmentKeyed,
        neverCheckedDetail: presentation.neverCheckedDetail,
        ...(presentation.cardMeta
          ? { extraMeta: (row: ProviderRow) => presentation.cardMeta?.(row.config ?? {}) ?? {} }
          : {}),
      }),
    );
  }

  // --- Runners / devices online ---
  const totalRunners = runnerRows.length;
  const onlineRunners = runnerRows.filter((r) => r.status === 'online').length;
  cards.push({
    key: 'runners',
    label: 'Runners',
    status: totalRunners === 0 ? 'not_configured' : onlineRunners > 0 ? 'connected' : 'attention',
    detail:
      totalRunners === 0
        ? 'no runners bound to this project'
        : `${onlineRunners}/${totalRunners} online`,
    lastSyncAt: null,
    configured: totalRunners > 0,
    meta: { online: onlineRunners, total: totalRunners },
  });

  // --- Postgres (the query above just succeeded → the DB is reachable) ---
  cards.push({
    key: 'postgres',
    label: 'Postgres',
    status: 'connected',
    detail: 'core database reachable',
    lastSyncAt: null,
    configured: true,
  });

  // --- Forge MCP server (mounted at /mcp on this core) ---
  cards.push({
    key: 'mcp',
    label: 'MCP server',
    status: 'connected',
    detail: 'Forge MCP server mounted at /mcp',
    lastSyncAt: null,
    configured: true,
  });

  // --- Sentry: now a per-project MCP-injection provider card (pushed above via
  // buildProviderCards, ISS-524) — the old global env-DSN tile was removed. ---

  // --- Claude (auth + quota are managed per-runner; no core-side backing data) ---
  cards.push({
    key: 'claude',
    label: 'Claude',
    status: 'not_configured',
    detail: 'auth + quota managed per-runner (no core-side metric)',
    lastSyncAt: null,
    configured: false,
  });

  return cards;
}
