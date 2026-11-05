// A drafted release decided by its listed approvers, keyed on its version (ISS-869). A project that
// declares no production cuts no run (NO_RELEASE_GATE): its master records the landing, so there is no
// request for a run's approval to decide; where the project's own rule still asks its owner to approve
// the release before the master records it, a holder of releases.approve decides the draft here: the
// permission alone decides, and an agent's token holding it decides too (ADR 0007, owner ruling
// 2026-10-04). It stands for the roster it was given on, and rests on no reading and no commit (owner
// ruling release-is-the-agents-record). Whether a draft decision is taken is one predicate
// (`draftDecisionRefusal`): the door refuses by it and the release read draws its Approve by it
// (ISS-1019), so a page never offers a decision the door refuses.

import {
  type ReleaseDraftApprovalView,
  releaseThroughChangeRequests,
} from '@forge/contracts/releases';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type ReleaseDraftApprovalRow,
  releaseDraftApprovals,
} from '../db/schema-release-ledger.js';
import { peopleOf } from '../lib/people.js';
import { RefusalError } from '../lib/refusal.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import { readReleasePath } from '../project-config/index.js';
import type { Carry } from './approval-carry.js';
import { draftedVersion } from './draft-version.js';
import { runCutAs } from './naming.js';
import { waitingIssueIds } from './queries.js';
import { refuseRelease } from './refuse.js';

type Decision =
  | { decision: 'approve'; reason?: string; carry?: Carry }
  | { decision: 'return'; reason: string };

const sameRoster = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

/**
 * Whether the project's releases are decided as drafts: it declares no production and releases
 * through no change requests, so no run is cut and its master records the landing (NO_RELEASE_GATE).
 * Null where they are; otherwise why not, as a refusal says it.
 */
export async function draftNotApprovableWhy(projectId: string): Promise<string | null> {
  const read = await readReleasePath(projectId);
  if (!read.ok) {
    return `the project document cannot be read as a release path (${read.reason}), so nothing says whether production is declared`;
  }
  if (read.path.production !== null) {
    return `this project declares production (${read.path.production.name}), so a release is cut as a run and its approval asked on it: POST /api/projects/${projectId}/release-batches/<runId>/approvals, decided by an approver`;
  }
  // a draft decision here would hide the cut its run's own approval decides, and nothing reads it (ISS-1019)
  if (releaseThroughChangeRequests(read.path.document)) {
    return `this project releases through its change requests (\`release.changeRequests\`), so a release is cut as a run and its approval asked on that run before its requests merge: cut it (POST /api/projects/${projectId}/release-batches), then decide the run's request`;
  }
  return null;
}

/** Why a draft decision on a version is refused: its code, its reason, and the field it names. */
export interface DraftDecisionRefusal {
  code: 'RELEASE_DRAFT_NOT_APPROVABLE' | 'RELEASE_VERSION_UNKNOWN';
  why: string;
}

/**
 * Whether a decision on the draft `version` is taken: null where it is; otherwise the refusal the door
 * answers with. The one reading both `decideDraftApproval` refuses by and the release read draws its
 * `can.decide` by (ISS-1019), so the page offers Approve exactly where the door takes it. The
 * permission is the caller's to weigh: it is the viewer's, not the draft's.
 */
export async function draftDecisionRefusal(
  projectId: string,
  version: string,
): Promise<DraftDecisionRefusal | null> {
  const why = await draftNotApprovableWhy(projectId);
  if (why) return { code: 'RELEASE_DRAFT_NOT_APPROVABLE', why };
  if (await runCutAs(projectId, version)) {
    return {
      code: 'RELEASE_DRAFT_NOT_APPROVABLE',
      why: `${version} is cut as a run, not a draft: its approval is asked on the run and decided there`,
    };
  }
  const drafted = await draftedVersion(projectId);
  if (drafted === version) return null;
  return {
    code: 'RELEASE_VERSION_UNKNOWN',
    why:
      drafted === null
        ? `${version} is not drafted in this project: nothing waits at the release gate, so no release is drafted to decide`
        : `${version} is not the drafted release of this project; the draft is ${drafted}, and a decision names the version it decides`,
  };
}

async function viewOf(row: ReleaseDraftApprovalRow): Promise<ReleaseDraftApprovalView> {
  const people = await peopleOf([row.decidedByUser]);
  const p = people.get(row.decidedByUser);
  return {
    id: row.id,
    version: row.version,
    decision: row.decision,
    decidedBy: { id: row.decidedByUser, name: p?.name ?? 'Unknown', kind: p?.kind ?? 'human' },
    decidedAt: row.decidedAt.toISOString(),
    reason: row.reason,
  };
}

/**
 * The standing decision on the draft `version` of `roster`: the latest one given on it, while the
 * roster it was given on is the draft's still; null where none was, or the roster changed since.
 */
export async function standingDraftApproval(
  projectId: string,
  version: string,
  roster: readonly string[],
): Promise<ReleaseDraftApprovalView | null> {
  const [latest] = await db
    .select()
    .from(releaseDraftApprovals)
    .where(
      and(
        eq(releaseDraftApprovals.projectId, projectId),
        eq(releaseDraftApprovals.version, version),
      ),
    )
    .orderBy(desc(releaseDraftApprovals.decidedAt), desc(releaseDraftApprovals.id))
    .limit(1);
  if (!latest || !sameRoster(latest.issueIds, roster)) return null;
  return viewOf(latest);
}

/**
 * A listed approver's decision on the draft `version`, recorded for the roster waiting at the gate.
 * Refused by name: an actor not holding releases.approve, a carry (a draft is judged by no
 * checklist, so nothing on it is carried), and whatever `draftDecisionRefusal` refuses.
 */
export async function decideDraftApproval(input: {
  projectId: string;
  version: string;
  userId: string;
  decision: Decision;
}): Promise<ReleaseDraftApprovalView> {
  const { projectId, version, userId, decision } = input;
  const denied = await permissionRefusalFor(
    actorFor(userId),
    'releases.approve',
    projectResource(projectId),
    'approving or returning a release',
  );
  if (denied) throw new RefusalError([denied], denied.code);
  if (decision.decision === 'approve' && decision.carry !== undefined) {
    throw refuseRelease(
      'RELEASE_APPROVAL_SHAPE',
      'a drafted release is decided on its roster and judged by no release approval checklist, so it has no unproven criterion to carry: send the approval without carry',
      '/carry',
    );
  }
  const refused = await draftDecisionRefusal(projectId, version);
  if (refused) throw refuseRelease(refused.code, refused.why, '/version');
  const roster = await waitingIssueIds(projectId);
  const [row] = await db
    .insert(releaseDraftApprovals)
    .values({
      projectId,
      version,
      issueIds: roster,
      decision: decision.decision === 'approve' ? 'approved' : 'returned',
      decidedByUser: userId,
      reason: decision.reason?.trim() || null,
    })
    .returning();
  if (!row) throw new Error('release-batch: the draft decision was not written');
  return viewOf(row);
}
