import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { effectiveConfig, getIntegration } from '../integrations/index.js';
import { getKnowledgeEntry } from '../knowledge/index.js';
import type { NamedEnvironment } from '../project-config/index.js';
import { type ReleaseDeclaration, resolveReleaseDeclaration } from './gate.js';
import {
  type CloseVerification,
  RELEASE_PROCEDURE_FACT,
  type ReleaseChannel,
  type ReleasePlan,
  type ReleaseRollback,
} from './plan.js';
import { blockerRefusal } from './refuse.js';
import type { VerifyConfig } from './verify.js';

export type { CloseVerification, ReleaseChannel, ReleaseVerification } from './plan.js';

/**
 * Read the production connection's stored `rollback` into what a release agent may act on.
 *
 * Prose on a COOLIFY binding is `unrepresentable`, not `manual`: Coolify
 * exposes a rollback API and Forge performs it, so a paragraph there is a
 * second path to the same outcome that nothing has verified is still true.
 */
function classifyRollback(provider: string, raw: unknown): ReleaseRollback | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.length === 0) return null;
    // ISS-1071 — a declared capability, not a name. Free text against a channel whose API CAN
    // express a rollback is a rollback nobody will perform, so it is refused; against one that
    // cannot, prose for a human is the only thing there is.
    return getIntegration(provider)?.capabilities.structuredRollback
      ? { kind: 'unrepresentable', text }
      : { kind: 'manual', text };
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { mode?: unknown }).mode === 'coolify-image'
  ) {
    return { kind: 'coolify-image' };
  }
  return null;
}

/** A release proves the commit it shipped, so only a probe identifying the source can prove it. */
function releaseProbesOf(production: NamedEnvironment): {
  verify: VerifyConfig | null;
  verifySource: ReleaseChannel['verifySource'];
} {
  const declared = production.declaration.verification?.runtime ?? [];
  const source = declared.filter((p) => p.identifies === 'source');
  if (source.length > 0) {
    return {
      verify: { probes: source.map((p) => ({ url: p.url, commitPath: p.path })) },
      verifySource: 'environment',
    };
  }
  return { verify: null, verifySource: declared.length > 0 ? 'declared-unusable' : 'none' };
}

function channelOf(decl: Extract<ReleaseDeclaration, { kind: 'gated' }>): ReleaseChannel {
  const pair = decl.binding;
  const label = effectiveConfig(pair).releaseRunnerLabel;
  return {
    environment: decl.production.name,
    bindingId: pair.binding.id,
    provider: pair.binding.provider,
    label: pair.binding.label,
    instructions: pair.binding.instructions ?? null,
    ...releaseProbesOf(decl.production),
    rollback: classifyRollback(
      pair.binding.provider,
      (pair.connection.config as Record<string, unknown> | null)?.rollback,
    ),
    releaseRunnerLabel: typeof label === 'string' && label.length > 0 ? label : null,
  };
}

/** The production environment's deploy binding, or none where the project is not gated. */
export async function resolveReleaseChannels(projectId: string): Promise<ReleaseChannel[]> {
  const decl = await resolveReleaseDeclaration(projectId);
  return decl?.kind === 'gated' ? [channelOf(decl)] : [];
}

/** How the binding is named where a person has to find it: environment, provider, store slug, id. */
function bindingName(channel: ReleaseChannel): string {
  const named = channel.label ? `${channel.provider} [${channel.label}]` : channel.provider;
  return `environment \`${channel.environment}\` (${named} ${channel.bindingId})`;
}

/** The production environments whose probes a release cannot compare with a commit. */
export function refusedVerifyBindings(channels: readonly ReleaseChannel[]): string[] {
  return channels.filter((c) => c.verifySource === 'declared-unusable').map(bindingName);
}

/**
 * How this release is proved, the one reading every door takes. THROWS where a binding's `verify`
 * was refused: that is a declaration to correct, and reading it as `unverified` would release past
 * the probes somebody meant to declare. Otherwise the first channel with probes proves it, whichever
 * binding sorts first; with none, the release is `unverified` and recorded as such.
 */
export function closeVerification(channels: readonly ReleaseChannel[]): CloseVerification {
  const refused = refusedVerifyBindings(channels);
  if (refused.length > 0) throw blockerRefusal('RELEASE_PROBES_UNREADABLE', { bindings: refused });
  const cfg = channels.find((c) => c.verify !== null)?.verify ?? null;
  return cfg ? { kind: 'probed', cfg } : { kind: 'unverified' };
}

/** The production binding's release runner label, or `null` where none is declared. */
export function releaseRunnerLabelOf(channels: readonly ReleaseChannel[]): string | null {
  return channels[0]?.releaseRunnerLabel ?? null;
}

export async function resolveReleasePlan(projectId: string): Promise<ReleasePlan> {
  const channels = await resolveReleaseChannels(projectId);
  const entry = await getKnowledgeEntry(projectId, RELEASE_PROCEDURE_FACT);
  const raw = entry && entry.archivedAt === null ? entry.body : null;
  return {
    channels,
    releaseRunnerLabel: releaseRunnerLabelOf(channels),
    procedure: raw !== null && raw.trim().length > 0 ? raw : null,
  };
}

/**
 * The devices whose runners carry the release label — the boxes a release
 * should PREFER.
 *
 * Empty means no box on the fleet carries it, which ISS-1128 made a ranking
 * rather than a refusal: the caller releases on the pool it has and records
 * that the preference went unmet. It was a refusal until then, so declaring
 * which box a release should prefer was indistinguishable from removing every
 * other box from the pool.
 */
export async function resolveReleaseDeviceIds(projectId: string, label: string): Promise<string[]> {
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT DISTINCT device_id
    FROM runners
    WHERE project_id = ${projectId}
      AND device_id IS NOT NULL
      AND labels ? ${label}
  `);
  return rows.map((r) => r.device_id);
}

/**
 * Every device this project has a runner row for, eligible or not.
 *
 * What separates a genuinely empty pool — `RELEASE_POOL_EMPTY` — from a fleet
 * that exists with nothing online, which is `NO_RUNNER_ONLINE` and always was.
 */
export async function projectRunnerDeviceIds(projectId: string): Promise<string[]> {
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT DISTINCT device_id
    FROM runners
    WHERE project_id = ${projectId}
      AND device_id IS NOT NULL
  `);
  return rows.map((r) => r.device_id);
}
