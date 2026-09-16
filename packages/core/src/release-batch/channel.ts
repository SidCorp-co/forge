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
// already lives — the `release-procedure` knowledge entry for the repo-side
// ritual (it was `projectFacts.release-procedure` until ISS-1048 moved project
// prose into `knowledge_entries`), and the live deploy binding's `instructions`
// for the channel-side one.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { effectiveConfig, listActiveDeployBindingsForStage } from '../integrations/store.js';
import { getKnowledgeEntry } from '../knowledge/service.js';
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
// cm:guard prose on a coolify binding must NOT degrade to `manual` — that is the silent substitution ISS-925 removed, and it reads identically to a working declaration. It is carried through so the prompt can quote it and settings can name the binding; it is never handed to an agent as an instruction. To undo the break, return `{kind:'manual'}` here.
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
// cm:guard the previous shape was `bindings[0]` off a query ordered `created_at ASC`, and that WAS the
// defect: on `getcontent` the oldest active `prod` binding is a Rocket.Chat room and on the archived
// `dodgeprint-api` it was a Sentry project, so the release agent was handed a chat channel and an
// error tracker as things to release onto. Adding a uniqueness constraint would not have fixed it —
// the fault was core choosing, not the set having more than one member.
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
      // cm:guard read the pool label out of `config`, NEVER out of `integration_bindings.label` — that column is the multi-store slug (ISS-558), and borrowing it would make "which box releases" and "which store is this" the same field
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
// cm:edge lockstep -> packages/core/src/devices/release-label.ts — `RELEASE_LABEL_FOR_JOB` is this rule in raw SQL, on the pool and claim paths. Looser there offers a release job to a box this would refuse.
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
