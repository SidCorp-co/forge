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
// and the production binding's `instructions` for the channel-side one.

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { effectiveConfig, listActiveBindingsForEnvironment } from '../integrations/store.js';
import { RELEASE_PROCEDURE_FACT, type ReleaseChannel, type ReleasePlan } from './plan.js';
import { parseVerifyConfig } from './verify.js';

export type { ReleaseChannel, ReleasePlan } from './plan.js';
export { DEFAULT_RELEASE_PROCEDURE, RELEASE_PROCEDURE_FACT } from './plan.js';

export async function resolveReleaseChannel(projectId: string): Promise<ReleaseChannel> {
  const bindings = await listActiveBindingsForEnvironment(projectId, 'prod');
  const pair = bindings[0];
  if (!pair) {
    return {
      provider: null,
      instructions: null,
      releaseRunnerLabel: null,
      verify: null,
      rollback: null,
    };
  }
  const cfg = effectiveConfig(pair);
  const label = cfg.releaseRunnerLabel;
  const rollback = cfg.rollback;
  return {
    provider: pair.binding.provider,
    instructions: pair.binding.instructions ?? null,
    verify: parseVerifyConfig(cfg.verify),
    rollback: typeof rollback === 'string' && rollback.trim().length > 0 ? rollback : null,
    // cm:guard read the pool label out of `config`, NEVER out of `integration_bindings.label` — that column is the multi-store slug (ISS-558) and sits inside UNIQUE(project_id, provider, environment, label), so borrowing it would make "which box releases" and "which store is this" the same field
    releaseRunnerLabel: typeof label === 'string' && label.length > 0 ? label : null,
  };
}

export async function resolveReleasePlan(projectId: string): Promise<ReleasePlan> {
  const channel = await resolveReleaseChannel(projectId);
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const ac = (row?.agentConfig ?? {}) as { projectFacts?: Record<string, unknown> };
  const raw = ac.projectFacts?.[RELEASE_PROCEDURE_FACT];
  return {
    ...channel,
    procedure: typeof raw === 'string' && raw.trim().length > 0 ? raw : null,
  };
}

/**
 * The devices whose runners carry the release label. Empty means the operator
 * named a pool that no box is in — which the caller must treat as a refusal,
 * never as "use anyone".
 */
// cm:guard the key is the LABEL, not a device id: a rebuilt box gets a new uuid and would silently drop out of a pool pinned by id, and the failure would read as "no runner online" rather than "the box you rebuilt lost its label"
// cm:why `labels ? ${label}` is jsonb element-membership, not key lookup — runners.labels is a jsonb ARRAY, and `?` reads an array as its set of elements
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
