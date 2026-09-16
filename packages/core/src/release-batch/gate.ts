// Does this project have a release step at all, and somewhere to perform it?
//
// ISS-764 asked the question of `states.tested` — a stage of the staged ladder,
// whose `mode: 'manual'` was read as "this project parks before release". ISS-897
// replaced that with two inferences: a branch comparison, ORed with a runner
// label on whatever row `listActiveBindingsForEnvironment(projectId,'prod')[0]`
// happened to return. Both were guesses about a thing nobody had been asked.
//
// ISS-1046 asks the project. `projects.release_model` is a declared column, and a
// `live` deploy binding is a declared place to perform the release on. The answer
// is `'awaiting_release'`, nothing, or a NAMED REFUSAL — a project that says it
// releases and has nowhere to release to is a misconfiguration to report, never a
// project to quietly treat as having no gate.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  projects,
  type ReleaseModel,
  type ReleaseStrategy,
} from '../db/schema.js';
import {
  type BindingWithConnection,
  listActiveDeployBindingsForStage,
} from '../integrations/store.js';
import { readableLiveBranch } from '../projects/release-model.js';

/** The one status an issue waits at for release. */
export const RELEASE_GATE_STATUS: IssueStatus = 'awaiting_release';

/** Thrown where a project declares a release model and nothing to release onto. */
export class ReleaseTargetUndeclaredError extends Error {
  readonly code = 'RELEASE_TARGET_UNDECLARED';
  constructor(
    readonly projectId: string,
    readonly releaseModel: ReleaseModel,
  ) {
    super(
      `RELEASE_TARGET_UNDECLARED: project ${projectId} declares releaseModel='${releaseModel}' but has no active deploy binding carrying the 'live' stage, so there is nowhere for a release to land. Either add one on the integrations screen, or set releaseModel='none' if this project ships nothing.`,
    );
    this.name = 'ReleaseTargetUndeclaredError';
  }
}

/**
 * What a release means on this project, and whether it can be performed.
 *
 * Three outcomes and no fourth. `no-release` and `undeclared-target` used to be the
 * same `null`, which is how a project whose only `prod` binding was an error tracker
 * presented as a project with nothing to release.
 */
export type ReleaseDeclaration =
  | { kind: 'no-release'; releaseModel: 'none'; baseBranch: string }
  | { kind: 'undeclared-target'; releaseModel: Exclude<ReleaseModel, 'none'> }
  | {
      kind: 'gated';
      releaseModel: Exclude<ReleaseModel, 'none'>;
      releaseStrategy: ReleaseStrategy | null;
      baseBranch: string;
      /** Non-null exactly under `promote`; `projects_live_branch_chk` holds that in Postgres. */
      liveBranch: string | null;
      /** EVERY active live deploy binding. Core does not choose among them. */
      liveBindings: BindingWithConnection[];
    };

/**
 * The declaration, read rather than inferred.
 */
export async function resolveReleaseDeclaration(
  projectId: string,
): Promise<ReleaseDeclaration | null> {
  const [row] = await db
    .select({
      baseBranch: projects.baseBranch,
      liveBranch: projects.liveBranch,
      releaseModel: projects.releaseModel,
      releaseStrategy: projects.releaseStrategy,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;

  const baseBranch = row.baseBranch ?? 'main';
  if (row.releaseModel === 'none') {
    return { kind: 'no-release', releaseModel: 'none', baseBranch };
  }

  const liveBindings = await listActiveDeployBindingsForStage(projectId, 'live');
  if (liveBindings.length === 0) {
    return { kind: 'undeclared-target', releaseModel: row.releaseModel };
  }

  return {
    kind: 'gated',
    releaseModel: row.releaseModel,
    releaseStrategy: row.releaseStrategy,
    baseBranch,
    liveBranch: readableLiveBranch(row),
    liveBindings,
  };
}

/**
 * The status issues must be at to join a batch release, or `null` when the project
 * ships nowhere else and the driver's `closed` means what it says.
 *
 * THROWS on `undeclared-target`. The caller 409s with `RELEASE_TARGET_UNDECLARED`;
 * the old code answered `null` there, which read to every caller as "this project
 * has no release step" — indistinguishable from a project that had declared so.
 */
export async function resolveReleaseGate(projectId: string): Promise<IssueStatus | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (!decl) return null;
  if (decl.kind === 'undeclared-target') {
    throw new ReleaseTargetUndeclaredError(projectId, decl.releaseModel);
  }
  return decl.kind === 'gated' ? RELEASE_GATE_STATUS : null;
}
