// The one park in decompose that core writes itself.
//
// Splitting an epic is not a decision the system may take alone, so the parent
// stops at `waiting` until a person has read the split. Keeping it here rather
// than in `decompose.ts` is not only length: this is the single place in core
// that still writes `waiting`, and its two exemptions — the RFC 0002 kind and
// reason, and the autonomous park rewrite — are easier to hold in one file than
// buried inside a 200-line transaction.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { applyStatusTransition } from './apply-transition.js';

export interface ReviewGateArgs {
  parentId: string;
  projectId: string;
  fromStatus: IssueStatus;
  createdEdges: number;
  /** Already decomposed once, or already sitting at the gate. */
  skip: boolean;
  autonomous: boolean;
}

/**
 * Park the parent at the review gate on its FIRST decomposition. Core owns this
 * transition (decompose redesign); it is not left to the skill, which
 * historically drifted — setting `on_hold` instead of `waiting` and breaking
 * the kickoff.
 *
 * Best-effort: the children are already committed, so a failure logs rather
 * than unwinding them.
 */
// cm:guard the ONLY `waiting` write left in core, and it MUST carry BOTH a kind and a reason (RFC 0002 INV-5/INV-8) — core is held to the same bar as an agent here, and dropping either argument makes this transition throw, which the catch below would swallow into a warn log and leave the parent un-parked with its children already created
// cm:guard `viaDecomposeGate` is what keeps this park representable on an autonomous project, where every OTHER device-actor `waiting` is rewritten to `needs_info` (issues/autonomous-park.ts). It must stay set: `needs_info` is woken by any human comment, and a comment on a decomposed parent is discussion of the split, not approval of it — waking it would dispatch the parent's integration before a single child exists.
export async function parkParentAtReviewGate(args: ReviewGateArgs): Promise<void> {
  if (args.skip || args.createdEdges === 0) return;
  try {
    // cm:why attribution only — `projects.createdBy` stands in as the system actor for a core-owned transition nobody authorized, and no authz is checked here
    const [project] = await db
      .select({ createdBy: projects.createdBy })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .limit(1);
    if (!project?.createdBy) return;
    await applyStatusTransition(
      { id: args.parentId, projectId: args.projectId, status: args.fromStatus, reopenCount: 0 },
      'waiting',
      { id: project.createdBy, ownerId: project.createdBy },
      {
        waitingKind: 'needs_decision',
        transitionReason: reviewGateReason(args.createdEdges, args.autonomous),
        viaDecomposeGate: true,
      },
    );
  } catch (err) {
    logger.warn(
      { err, parentId: args.parentId, from: args.fromStatus },
      'decompose: parent → waiting review-gate transition failed',
    );
  }
}

// cm:edge contract -> packages/core/src/pipeline/decomposition-subscribers.ts — this text tells the human which status to write, and the cascade fires on that status ONLY. `approved` is absent from the autonomous board's vocabulary (packages/contracts/src/issue-vocabulary.ts has no LABEL_TO_KERNEL entry for it), so naming it on an autonomous project sends the reader to a transition their UI cannot offer — the stall ISS-886 was filed for.
export function reviewGateReason(createdEdges: number, autonomous: boolean): string {
  const plural = createdEdges === 1 ? '' : 's';
  const target = autonomous ? '`open`' : '`approved`';
  return `Decomposed into ${createdEdges} child issue${plural}. Review the split, then move this parent to ${target} to promote every child from \`draft\` to ${target}. The parent's own integration work runs LAST, after every child's code has merged.`;
}
