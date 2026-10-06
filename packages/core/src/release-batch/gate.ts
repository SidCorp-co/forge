import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import {
  type BindingWithConnection,
  listActiveDeployBindingsForStage,
} from '../integrations/store.js';
import {
  chainLiveBranch,
  chainShipsNothing,
  chainStartBranch,
  type ReleaseChain,
} from '../projects/release-chain.js';

/** The one status an issue waits at for release. */
export const RELEASE_GATE_STATUS: IssueStatus = 'awaiting_release';

/** Thrown where a project declares a release chain and nothing to release onto. */
export class ReleaseTargetUndeclaredError extends Error {
  readonly code = 'RELEASE_TARGET_UNDECLARED';
  constructor(
    readonly projectId: string,
    readonly releaseChain: ReleaseChain,
  ) {
    super(
      `RELEASE_TARGET_UNDECLARED: project ${projectId} declares a release chain ending at '${chainLiveBranch(releaseChain) ?? chainStartBranch(releaseChain)}' but has no active deploy binding carrying the 'live' stage, so there is nowhere for a release to land. Either add one on the integrations screen, or, if this project ships nothing, press "This project ships nothing" on its Repository settings tab.`,
    );
    this.name = 'ReleaseTargetUndeclaredError';
  }
}

export type ReleaseDeclaration =
  | { kind: 'no-release'; releaseChain: ReleaseChain; baseBranch: string }
  | { kind: 'undeclared-target'; releaseChain: ReleaseChain }
  | {
      kind: 'gated';
      /** The WHOLE ordered path: a crossing is a fact about one edge, so no field reduces it. */
      releaseChain: ReleaseChain;
      baseBranch: string;
      /** Non-null exactly where the chain has two or more entries. */
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
      releaseChain: projects.releaseChain,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;

  const baseBranch = row.baseBranch ?? 'main';
  const releaseChain = row.releaseChain;
  if (chainShipsNothing(releaseChain)) {
    return { kind: 'no-release', releaseChain, baseBranch };
  }

  const liveBindings = await listActiveDeployBindingsForStage(projectId, 'live');
  if (liveBindings.length === 0) {
    return { kind: 'undeclared-target', releaseChain };
  }

  return {
    kind: 'gated',
    releaseChain,
    baseBranch,
    liveBranch: chainLiveBranch(releaseChain),
    liveBindings,
  };
}

/**
 * The status issues must be at to join a batch release, or `null` when the project
 * ships nowhere else and the driver's `closed` means what it says.
 *
 * THROWS on `undeclared-target`. The caller 409s with `RELEASE_TARGET_UNDECLARED`; answering
 * `null` there reads to every caller as a project that declared it ships nothing.
 */
export async function resolveReleaseGate(projectId: string): Promise<IssueStatus | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (!decl) return null;
  if (decl.kind === 'undeclared-target') {
    throw new ReleaseTargetUndeclaredError(projectId, decl.releaseChain);
  }
  return decl.kind === 'gated' ? RELEASE_GATE_STATUS : null;
}
