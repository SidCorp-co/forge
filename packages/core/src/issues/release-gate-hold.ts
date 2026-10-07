import { db } from '../db/client.js';
import { comments, type IssueStatus } from '../db/schema.js';
import { logger } from '../logger.js';
import { resolveReleaseGate } from '../release-batch/gate.js';
import type { ActorAgency } from './actor-agency.js';

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

  const gate = await resolveReleaseGate(args.projectId);
  if (!gate) return pass;
  return { status: gate, held: true };
}

/** The note a held close leaves on the issue, after the hold has committed; its failure is logged, never thrown. */
export async function postReleaseGateHoldComment(issueId: string, authorId: string): Promise<void> {
  try {
    await db.insert(comments).values({
      issueId,
      authorId,
      body: `Held at the release gate — merged, not shipped. Every \`blocks\`-dependent can dispatch now, because a dependent is held by this issue's STATUS and \`awaiting_release\` is one that releases it; nothing here writes \`merged_at\`. The issue closes when a release ships it, and that close is refused until the shipped-work claim is on the row — \`forge_issues\` \`mark_merged\` naming where it landed.`,
      parentId: null,
    });
  } catch (err) {
    logger.warn(
      { err, issueId },
      'transition: release-gate hold comment failed (transition already committed)',
    );
  }
}
