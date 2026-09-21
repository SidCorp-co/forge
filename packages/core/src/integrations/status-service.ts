import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { getIntegration, listIntegrations } from './registry.js';
import { notFound, toIso } from './route-helpers.js';
import { effectiveConfig, listBindingsForProject } from './store.js';
import type { IntegrationCapabilities, IntegrationProvider } from './types.js';

const pExecFile = promisify(execFile);

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

/** Best-effort `git remote get-url origin` against a local checkout. */
async function readGitRemote(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 3000,
      windowsHide: true,
    });
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
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

function stageKey(row: { role: string; stages: string[] }): string {
  return row.role === 'service' ? 'service' : row.stages.join('+') || 'deploy';
}

function stageLabel(row: { role: string; stages: string[] }): string {
  if (row.role === 'service') return 'service';
  return row.stages.map((s) => (s === 'live' ? 'Live' : 'Preview')).join(' + ') || 'deploy';
}

/** Flattened binding+connection row the status cards render from. */
interface ProviderRow {
  /** The binding's own id. The one thing about a card that is unique whatever else two
   *  bindings share, and the handle a screen needs to address ONE of them. */
  id: string;
  provider: string;
  role: string;
  stages: string[];
  config: Record<string, unknown>;
  active: boolean;
  lastHealthStatus: string | null;
  lastHealthAt: Date | null;
  breakerOpenedAt: Date | null;
}

/**
 * Shared builder for the coolify/postman/epodsystem status cards (ISS-431) —
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
    label: envKeyed ? `${opts.label} (${stageLabel(row)})` : opts.label,
    status: healthToStatus(row.lastHealthStatus, row.active),
    detail: !row.active
      ? 'integration disabled'
      : row.lastHealthStatus
        ? `last health: ${row.lastHealthStatus}`
        : opts.neverCheckedDetail,
    lastSyncAt: toIso(row.lastHealthAt),
    configured: true,
    meta: {
      bindingId: row.id,
      role: row.role,
      stages: row.stages,
      breakerOpen: row.breakerOpenedAt !== null,
      lastHealthStatus: row.lastHealthStatus,
      capabilities: caps,
      ...(opts.extraMeta?.(row) ?? {}),
    },
  }));
}

/** Build the full status-card set for a project (caller has already authz'd). */
export async function buildIntegrationsStatusCards(projectId: string): Promise<StatusCard[]> {
  const [project] = await db
    .select({ repoPath: projects.repoPath, baseBranch: projects.baseBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');

  // One row per active binding, joined to its connection (health/breaker live on
  // the connection). Flattened to the shape the cards below already consume.
  const pairs = await listBindingsForProject(projectId);
  const integrationRows = pairs.map((pair) => ({
    id: pair.binding.id,
    provider: pair.binding.provider,
    role: pair.binding.role,
    stages: (pair.binding.stages ?? []) as string[],
    config: effectiveConfig(pair),
    active: pair.binding.active && pair.connection.active,
    lastHealthStatus: pair.connection.lastHealthStatus,
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

  // --- GitHub (repo + per-device push-cred) ---
  const remoteUrl = project.repoPath ? await readGitRemote(project.repoPath) : null;
  const transport = classifyGitRemote(remoteUrl);
  const deviceCreds = runnerRows
    .filter((r) => r.deviceId)
    .map((r) => ({
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      pushCredProvisioned: r.gitCredentialRef !== null,
    }));
  cards.push({
    key: 'github',
    label: 'GitHub',
    status: project.repoPath ? 'connected' : 'not_configured',
    detail: remoteUrl ?? project.repoPath ?? 'no repo configured',
    lastSyncAt: null,
    configured: Boolean(project.repoPath),
    meta: { transport, remoteUrl, baseBranch: project.baseBranch, deviceCreds },
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
        alwaysEnvKeyed: presentation.alwaysStageKeyed,
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
