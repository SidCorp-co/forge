// What ships this project, and who is allowed to ship it.
//
// The batch prompt used to carry one procedure for everyone: merge to the
// production branch, deploy through Coolify, append one line under
// `## [Unreleased]`. That is one project's ritual written as if it were the
// protocol. epodsystem cuts a no-squash MR plus a tag, has no Coolify, and
// promotes a version section rather than appending to `[Unreleased]`.
//
// So the split is: the PROTOCOL (get → … → finish/abort) stays hard in the
// state prompt, because it is what stops a claim being made for work that did
// not happen. The PROCEDURE is per project and lives where per-project text
// already lives — `projectFacts.release-procedure` for the repo-side ritual,
// and the live deploy binding's `instructions` for the channel-side one.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { effectiveConfig, listActiveDeployBindingsForStage } from '../integrations/store.js';
import {
  RELEASE_PROCEDURE_FACT,
  type ReleaseChannel,
  type ReleasePlan,
  type ReleaseRollback,
} from './plan.js';
import { parseVerifyConfig } from './verify.js';

export type { ReleaseChannel, ReleasePlan, ReleaseRollback } from './plan.js';
export { defaultReleaseProcedure, RELEASE_PROCEDURE_FACT } from './plan.js';

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
    return provider === 'coolify' ? { kind: 'unrepresentable', text } : { kind: 'manual', text };
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

/**
 * EVERY active live deploy binding, each with its own channel declaration.
 *
 * A set, not a pick. Deploy is a tool handed to an agent, not a switch core throws, so core returns
 * the whole stage and the release agent works it; an endpoint with no adapter is described in
 * `instructions` as a guide or a requirement, handled by hand, and reported into the release job like
 * any other step.
 */
export async function resolveReleaseChannels(projectId: string): Promise<ReleaseChannel[]> {
  const pairs = await listActiveDeployBindingsForStage(projectId, 'live');
  return pairs.map((pair) => {
    const cfg = effectiveConfig(pair);
    const label = cfg.releaseRunnerLabel;
    return {
      bindingId: pair.binding.id,
      provider: pair.binding.provider,
      label: pair.binding.label,
      instructions: pair.binding.instructions ?? null,
      verify: parseVerifyConfig(cfg.verify),
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
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { projectFacts?: Record<string, unknown> };
  const raw = ac.projectFacts?.[RELEASE_PROCEDURE_FACT];
  return {
    channels,
    releaseRunnerLabel: releaseRunnerLabelOf(projectId, channels),
    procedure: typeof raw === 'string' && raw.trim().length > 0 ? raw : null,
  };
}

/**
 * The devices whose runners carry the release label. Empty means the operator
 * named a pool that no box is in — which the caller must treat as a refusal,
 * never as "use anyone".
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
