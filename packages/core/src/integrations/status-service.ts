/**
 * ISS-305 — composed read-only integrations status for the web hub
 * (`GET /:projectId/integrations/status` — thin handler in routes.ts).
 *
 * Aggregates ONLY real, already-existing signals — no fabricated metrics. Each
 * card carries a status the UI renders with icon + text (never color-only) plus
 * a last-sync timestamp where one genuinely exists. Providers with no backing
 * data render `not_configured` rather than inventing health. Each provider card
 * also carries its adapter `capabilities` so the UI renders to the provider's
 * archetype (e.g. no delivery-log affordance for MCP-injection providers).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { classifyGitRemote } from '../git/provision-credential.js';
import { getAdapter } from './registry.js';
import { notFound, toIso } from './route-helpers.js';
import { resolveSentryTargets } from './sentry/targets.js';
import type { SentryConfig } from './sentry/types.js';
import { effectiveConfig, listBindingsForProject } from './store.js';
import { type IntegrationProvider, capabilitiesFor } from './types.js';

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
  // needs_reauth (ISS-409) is operator-actionable (re-enter the credential), so
  // it buckets to `attention`; F3 reads the raw lastHealthStatus for a re-auth chip.
  if (s === 'needs_reauth') return 'attention';
  return 'error';
}

/** Adapter capabilities for a provider, for capability-aware card rendering. */
function providerCapabilities(provider: IntegrationProvider) {
  return capabilitiesFor(getAdapter(provider));
}

/** Flattened binding+connection row the status cards render from. */
interface ProviderRow {
  provider: string;
  environment: string;
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
  return opts.rows.map((row) => ({
    key: envKeyed ? `${opts.provider}:${row.environment}` : opts.provider,
    label: envKeyed ? `${opts.label} (${row.environment})` : opts.label,
    status: healthToStatus(row.lastHealthStatus, row.active),
    detail: !row.active
      ? 'integration disabled'
      : row.lastHealthStatus
        ? `last health: ${row.lastHealthStatus}`
        : opts.neverCheckedDetail,
    lastSyncAt: toIso(row.lastHealthAt),
    configured: true,
    meta: {
      environment: row.environment,
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
    provider: pair.binding.provider,
    environment: pair.binding.environment,
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

  // --- Provider cards: one card PER BINDING (ISS-429 — a disabled binding
  // must not shadow an active one), built by the shared builder (ISS-431).
  // Epodsystem meta carries only non-secret store identity — never the crmk_
  // key. ---
  cards.push(
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'coolify'),
      provider: 'coolify',
      label: 'Coolify',
      alwaysEnvKeyed: true,
      neverCheckedDetail: 'never health-checked',
    }),
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'postman'),
      provider: 'postman',
      label: 'Postman',
      alwaysEnvKeyed: false,
      neverCheckedDetail: 'never test-connected',
      extraMeta: (row) => {
        const cfg = (row.config ?? {}) as { region?: string; mode?: string };
        return { region: cfg.region ?? 'us', mode: cfg.mode ?? 'minimal' };
      },
    }),
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'epodsystem'),
      provider: 'epodsystem',
      label: 'Epodsystem',
      alwaysEnvKeyed: false,
      neverCheckedDetail: 'never test-connected',
      extraMeta: (row) => {
        const cfg = (row.config ?? {}) as { storeSlug?: string; storeName?: string };
        return { storeSlug: cfg.storeSlug ?? null, storeName: cfg.storeName ?? null };
      },
    }),
    // ISS-524 — Sentry is now a per-project MCP-injection provider (binding-
    // derived), no longer a global env-DSN status tile. Drillable → opens the
    // Sentry config section.
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'sentry'),
      provider: 'sentry',
      label: 'Sentry',
      alwaysEnvKeyed: false,
      neverCheckedDetail: 'never test-connected',
      extraMeta: (row) => {
        const cfg = (row.config ?? {}) as SentryConfig;
        // ISS-526 — surface the multi-target shape: count + the first target's
        // org for the card subtitle. Defensive (no throw on missing config);
        // back-compat read covers the legacy single-slug connection.
        const targets = resolveSentryTargets(cfg);
        return {
          host: cfg.host ?? null,
          organizationSlug: targets[0]?.organizationSlug ?? cfg.organizationSlug ?? null,
          targetCount: targets.length,
        };
      },
    }),
    // ISS-609 — Rocket.Chat bot: connection-only provider; card surfaces the
    // server + bound room so the project settings tab shows the live wiring.
    ...buildProviderCards({
      rows: integrationRows.filter((r) => r.provider === 'rocketchat'),
      provider: 'rocketchat',
      label: 'Rocket.Chat',
      alwaysEnvKeyed: false,
      neverCheckedDetail: 'never test-connected',
      extraMeta: (row) => {
        const cfg = (row.config ?? {}) as { serverUrl?: string; rids?: string[] };
        return { serverUrl: cfg.serverUrl ?? null, rids: cfg.rids ?? null };
      },
    }),
  );

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
