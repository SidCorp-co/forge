import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  type BindingWithConnection,
  bindingNames,
  connectionHealthStatus,
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

/** The card's coarser bucket over the connection rule: every state that wants a look is `attention`. */
function healthToStatus(lastHealthStatus: string | null, active: boolean): CardStatus {
  const status = connectionHealthStatus({ active, lastHealthStatus, breakerOpenedAt: null });
  return status === 'degraded' || status === 'needs_reauth' || status === 'needs_scope'
    ? 'attention'
    : status === 'not_connected'
      ? 'not_configured'
      : status;
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
  /** What tells this binding apart from the others of its provider and role (`bindingNames`). */
  name: string;
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
    label: envKeyed ? `${opts.label} (${row.name})` : opts.label,
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
      name: row.name,
      breakerOpen: row.breakerOpenedAt !== null,
      lastHealthStatus: row.lastHealthStatus,
      capabilities: caps,
      ...(opts.extraMeta?.(row) ?? {}),
    },
  }));
}

/** The binding serving the declared repository's host, a live one before a switched-off one, oldest first. */
function repositoryBinding(
  pairs: readonly BindingWithConnection[],
  host: string,
): { pair: BindingWithConnection; label: string } | null {
  const onHost = pairs
    .flatMap((pair) => {
      const factory = getIntegration(pair.binding.provider)?.sourceHost;
      return factory && factory.hostOf(effectiveConfig(pair)) === host
        ? [{ pair, label: factory.label }]
        : [];
    })
    .sort(
      (a, b) =>
        Number(b.pair.binding.active && b.pair.connection.active) -
          Number(a.pair.binding.active && a.pair.connection.active) ||
        a.pair.binding.createdAt.getTime() - b.pair.binding.createdAt.getTime(),
    );
  return onHost[0] ?? null;
}

/** The source-host provider that serves `host` with no host of its own configured, if any does. */
function providerServing(host: string): { provider: string; label: string } | null {
  for (const decl of listIntegrations()) {
    if (decl.sourceHost && decl.sourceHost.hostOf({}) === host) {
      return { provider: decl.provider, label: decl.sourceHost.label };
    }
  }
  return null;
}

const UNREACHED_COST =
  'Forge cannot read its commits, merge into it or compare branches, so a release cannot tell what already shipped';

/**
 * The declared repository, connected only where a source host binding reaches it: a repository no
 * host serves is not connected, whatever the document says, and the card names what that costs and
 * the act that fixes it (`meta.connectProvider`).
 */
function repositoryCard(
  pairs: readonly BindingWithConnection[],
  source: Pick<Awaited<ReturnType<typeof readDeclaredSource>>, 'repository' | 'defaultBranch'>,
): StatusCard {
  const { repository } = source;
  const host = hostOfRepository(repository);
  const reached = host ? repositoryBinding(pairs, host) : null;
  const serving = host && !reached ? providerServing(host) : null;
  const meta = {
    repository,
    remoteUrl: repository ? webUrlOf(repository) : null,
    baseBranch: source.defaultBranch,
    host,
    provider: reached?.pair.binding.provider ?? null,
    connectProvider: serving?.provider ?? null,
  };
  if (!repository) {
    return {
      key: 'repository',
      label: 'Repository',
      status: 'not_configured',
      detail: 'the project document declares no repository',
      lastSyncAt: null,
      configured: false,
      meta,
    };
  }
  if (!host) {
    return {
      key: 'repository',
      label: 'Repository',
      status: 'not_configured',
      detail: `a local path no host serves: ${UNREACHED_COST}. Its head is read from a runner's bound checkout; declare the hosted repository to read the rest`,
      lastSyncAt: null,
      configured: true,
      meta,
    };
  }
  if (!reached) {
    return {
      key: 'repository',
      label: 'Repository',
      status: 'not_configured',
      detail: `no source host binding reaches ${host}: ${UNREACHED_COST}. ${
        serving
          ? `Connect ${serving.label} to fix it`
          : `Bind a source host connection serving ${host} to fix it`
      }`,
      lastSyncAt: null,
      configured: true,
      meta,
    };
  }
  const { binding, connection } = reached.pair;
  const active = binding.active && connection.active;
  return {
    key: `${binding.provider}:repository`,
    label: `${reached.label} repository`,
    status: healthToStatus(connection.lastHealthStatus, active),
    detail: !active
      ? `the ${reached.label} binding that reaches it is switched off: ${UNREACHED_COST}`
      : connection.lastHealthStatus
        ? `read through ${reached.label} — last health: ${connection.lastHealthStatus}`
        : `read through ${reached.label} — never health-checked`,
    lastSyncAt: toIso(connection.lastHealthAt),
    configured: true,
    meta,
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
  const named = pairs.map((pair) => ({
    id: pair.binding.id,
    provider: pair.binding.provider,
    role: pair.binding.role,
    environment: deployMap.environments.get(pair.binding.id)?.name ?? null,
    label: pair.binding.label ?? '',
    config: effectiveConfig(pair),
  }));
  const names = bindingNames(named);
  const rows: ProviderRow[] = pairs.map((pair, i) => ({
    ...(named[i] as (typeof named)[number]),
    name: names.get(pair.binding.id) ?? '',
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

/**
 * The project's integration cards: the declared repository, then one card per binding of every
 * provider that declares a presentation (caller has already authz'd). Core health — the runner pool,
 * the database, the MCP mount, the agent — is not an integration a person connects, and is read on
 * the screens that own it.
 */
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
  return [repositoryCard(pairs, source), ...providerCards(pairs, deployMap)];
}
