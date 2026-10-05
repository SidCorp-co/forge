import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, runners } from '../db/schema.js';
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

interface StatusCard {
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

/** One provider's cards; providers differ only in env-keying, the never-checked wording and their meta. */
function buildProviderCards(opts: {
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
function repositoryProvider(
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

/** The declared repository, keyed and labelled by the provider its host is. */
function repositoryCard(
  pairs: readonly BindingWithConnection[],
  source: Awaited<ReturnType<typeof readDeclaredSource>>,
): StatusCard {
  const { repository } = source;
  const host = repositoryProvider(pairs, repository);
  return {
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
      remoteUrl: repository ? webUrlOf(repository) : null,
      baseBranch: source.defaultBranch,
      provider: host?.provider ?? null,
    },
  };
}

/**
 * One card PER BINDING (ISS-429 — a disabled binding must not shadow an active one), for every
 * provider that declares a presentation, in registry order (ISS-1071).
 */
function providerCards(
  pairs: readonly BindingWithConnection[],
  deployMap: Awaited<ReturnType<typeof readDeployMap>>,
): StatusCard[] {
  const rows: ProviderRow[] = pairs.map((pair) => ({
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
  return listIntegrations().flatMap((decl) => {
    const presentation = decl.presentation;
    if (!presentation) return [];
    return buildProviderCards({
      rows: rows.filter((r) => r.provider === decl.provider),
      provider: decl.provider,
      label: presentation.label,
      alwaysEnvKeyed: presentation.alwaysEnvironmentKeyed,
      neverCheckedDetail: presentation.neverCheckedDetail,
      ...(presentation.cardMeta
        ? { extraMeta: (row: ProviderRow) => presentation.cardMeta?.(row.config ?? {}) ?? {} }
        : {}),
    });
  });
}

async function runnersCard(projectId: string): Promise<StatusCard> {
  const rows = await db
    .select({ status: runners.status })
    .from(runners)
    .where(eq(runners.projectId, projectId));
  const total = rows.length;
  const online = rows.filter((r) => r.status === 'online').length;
  return {
    key: 'runners',
    label: 'Runners',
    status: total === 0 ? 'not_configured' : online > 0 ? 'connected' : 'attention',
    detail: total === 0 ? 'no runners bound to this project' : `${online}/${total} online`,
    lastSyncAt: null,
    configured: total > 0,
    meta: { online, total },
  };
}

/** Cards with no backing data to read: the queries above succeeding is the Postgres signal. */
const FIXED_CARDS: readonly StatusCard[] = [
  {
    key: 'postgres',
    label: 'Postgres',
    status: 'connected',
    detail: 'core database reachable',
    lastSyncAt: null,
    configured: true,
  },
  {
    key: 'mcp',
    label: 'MCP server',
    status: 'connected',
    detail: 'Forge MCP server mounted at /mcp',
    lastSyncAt: null,
    configured: true,
  },
  {
    key: 'claude',
    label: 'Claude',
    status: 'not_configured',
    detail: 'auth + quota managed per-runner (no core-side metric)',
    lastSyncAt: null,
    configured: false,
  },
];

/** Build the full status-card set for a project (caller has already authz'd). */
export async function buildIntegrationsStatusCards(projectId: string): Promise<StatusCard[]> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');
  const [pairs, deployMap, source] = await Promise.all([
    listBindingsForProject(projectId),
    readDeployMap(projectId),
    readDeclaredSource(projectId),
  ]);
  return [
    repositoryCard(pairs, source),
    ...providerCards(pairs, deployMap),
    await runnersCard(projectId),
    ...FIXED_CARDS.map((card) => ({ ...card })),
  ];
}
