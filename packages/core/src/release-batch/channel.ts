import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { getIntegration } from '../integrations/registry.js';
import { effectiveConfig, listActiveDeployBindingsForStage } from '../integrations/store.js';
import { getKnowledgeEntry } from '../knowledge/service.js';
import { normalizeEnvironments } from '../projects/environments.js';
import {
  RELEASE_PROCEDURE_FACT,
  type ReleaseChannel,
  type ReleasePlan,
  type ReleaseRollback,
} from './plan.js';
import { parseVerifyConfig, type VerifyConfig } from './verify.js';

export type { ReleaseChannel, ReleasePlan, ReleaseRollback } from './plan.js';
export { RELEASE_PROCEDURE_FACT } from './plan.js';

/**
 * Read one binding's stored `rollback` into what a release agent may act on.
 *
 * Prose on a COOLIFY binding is `unrepresentable`, not `manual`: Coolify
 * exposes a rollback API and Forge performs it, so a paragraph there is a
 * second path to the same outcome that nothing has verified is still true.
 */
export function classifyRollback(provider: string, raw: unknown): ReleaseRollback | null {
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

export function liveProbeFrom(environments: unknown): VerifyConfig | null {
  const live = normalizeEnvironments(environments).live;
  if (live.commitUrl === null) return null;
  return parseVerifyConfig({
    probes: [{ url: live.commitUrl, commitPath: live.commitPath ?? undefined }],
  });
}

export async function resolveReleaseChannels(projectId: string): Promise<ReleaseChannel[]> {
  const pairs = await listActiveDeployBindingsForStage(projectId, 'live');
  if (pairs.length === 0) return [];
  const [row] = await db
    .select({ environments: projects.environments })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const fallback = liveProbeFrom(row?.environments);
  return pairs.map((pair) => {
    const cfg = effectiveConfig(pair);
    const label = cfg.releaseRunnerLabel;
    const declared = parseVerifyConfig(cfg.verify);
    const absent = cfg.verify === undefined || cfg.verify === null;
    const verify = declared ?? (absent ? fallback : null);
    return {
      bindingId: pair.binding.id,
      provider: pair.binding.provider,
      label: pair.binding.label,
      instructions: pair.binding.instructions ?? null,
      verify,
      verifySource: declared
        ? ('binding' as const)
        : verify
          ? ('environments-live' as const)
          : ('none' as const),
      rollback: classifyRollback(pair.binding.provider, cfg.rollback),
      releaseRunnerLabel: typeof label === 'string' && label.length > 0 ? label : null,
    };
  });
}

/** Thrown where the live deploy bindings disagree about which box may ship the project. */
export class ReleaseRunnerAmbiguousError extends Error {
  readonly code = 'RELEASE_RUNNER_AMBIGUOUS';
  constructor(
    readonly projectId: string,
    readonly labels: string[],
  ) {
    super(
      `RELEASE_RUNNER_AMBIGUOUS: project ${projectId} has live deploy bindings declaring different releaseRunnerLabel values (${labels.join(', ')}), so there is no one box the release job may be offered to. Core returns the whole deploy SET and never picks among it — but the runner label selects a machine, and two answers is an undeclared pool rather than a set to work. Make the labels agree, or clear all but one.`,
    );
    this.name = 'ReleaseRunnerAmbiguousError';
  }
}

/**
 * The one release runner label for a project, or `null` where none is declared.
 *
 * THROWS where two live bindings disagree. This is the one axis on which the set still collapses to
 * a single answer, because it names a machine: sending the job to whichever row sorted first is the
 * same silent pick `resolveReleaseChannels` exists to remove.
 */
export function releaseRunnerLabelOf(projectId: string, channels: ReleaseChannel[]): string | null {
  const labels = [...new Set(channels.map((c) => c.releaseRunnerLabel).filter((l) => l !== null))];
  if (labels.length > 1) throw new ReleaseRunnerAmbiguousError(projectId, labels);
  return labels[0] ?? null;
}

export async function resolveReleasePlan(projectId: string): Promise<ReleasePlan> {
  const channels = await resolveReleaseChannels(projectId);
  const entry = await getKnowledgeEntry(projectId, RELEASE_PROCEDURE_FACT);
  const raw = entry && entry.archivedAt === null ? entry.body : null;
  return {
    channels,
    releaseRunnerLabel: releaseRunnerLabelOf(projectId, channels),
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
