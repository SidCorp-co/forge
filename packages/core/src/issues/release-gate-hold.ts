import { postSystemComment } from '../comments/system-write.js';
import type { IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import { ReleaseTargetUndeclaredError, resolveReleaseGate } from '../release-batch/gate.js';
import type { ActorAgency } from './actor-agency.js';
import { releaseTagOf } from './release-tag-close.js';
import { TransitionError } from './transition-error.js';

export interface CloseTargetDecision {
  status: IssueStatus;
  /** The close was converted into a park at the gate. */
  held: boolean;
}

export async function resolveAgentCloseTarget(args: {
  projectId: string;
  requested: IssueStatus;
  agency: ActorAgency;
  viaReleasePath: boolean;
}): Promise<CloseTargetDecision> {
  const pass = { status: args.requested, held: false };
  if (args.requested !== 'closed') return pass;
  if (args.agency !== 'agent') return pass;
  if (args.viaReleasePath) return pass;
  // A project that ships by tag is not held at the gate and then closed by a release batch: its
  // close is decided by whether a tag contains the landing (`refuseUnreleasedClose`), for every
  // actor, so rewriting an agent's close to `awaiting_release` would answer a different question.
  if ((await releaseTagOf(args.projectId)) !== null) return pass;

  const gate = await gateOf(args.projectId);
  if (!gate) return pass;
  return { status: gate, held: true };
}

/** The gate an agent's close is held at, with a project that declares a release and nowhere to land it refused by name: `closed` there is neither held nor allowed. */
async function gateOf(projectId: string): Promise<IssueStatus | null> {
  try {
    return await resolveReleaseGate(projectId);
  } catch (err) {
    if (!(err instanceof ReleaseTargetUndeclaredError)) throw err;
    throw new TransitionError('RELEASE_TARGET_UNDECLARED', err.detail, {
      projectId: err.projectId,
      releaseChain: err.releaseChain,
    });
  }
}

/** The note a held close leaves on the issue, after the hold has committed; its failure is logged, never thrown. */
export async function postReleaseGateHoldComment(issueId: string, authorId: string): Promise<void> {
  try {
    await postSystemComment({
      issueId,
      authorId,
      body: `Held at the release gate — merged, not released. Every \`blocks\`-dependent can dispatch now, because a dependent is held by this issue's STATUS and Awaiting release is one that releases it; nothing here writes \`merged_at\`. The issue closes when a release carries it, and that close is refused until the merge mark is on the row — \`forge_issues\` \`mark_merged\` naming where it landed.`,
      parentId: null,
    });
  } catch (err) {
    logger.warn(
      { err, issueId },
      'transition: release-gate hold comment failed (transition already committed)',
    );
  }
}
