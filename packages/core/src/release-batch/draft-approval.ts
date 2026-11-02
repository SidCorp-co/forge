// A drafted release decided by its listed approvers, keyed on its version (ISS-869). A project that
// declares no production cuts no run (NO_RELEASE_GATE), so there is no request for a run's approval
// to decide; where the project's own rule still asks its owner to approve the release before the
// master acts on it, the owner decides the draft here. The decision is a person's: an agent's token is
// refused, as the release's page names people only as its approvers. It stands for the roster it was
// given on, and rests on no reading and no commit (owner ruling release-is-the-agents-record).

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReleaseDraftApprovalView } from '@forge/contracts/releases';
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
import { draftedVersion } from './draft-version.js';
import { runCutAs } from './naming.js';
import { waitingIssueIds } from './queries.js';
import { refuseRelease } from './refuse.js';

type Decision = { decision: 'approve'; reason?: string } | { decision: 'return'; reason: string };

const sameRoster = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);

/**
 * Whether the project's releases are decided as drafts: it declares no production, so no run is cut.
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
  return null;
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
 * Refused by name: a token of an agent's, a viewer not holding releases.approve, a project that
 * declares production, a version cut as a run, and a version that is not the draft.
 */
export async function decideDraftApproval(input: {
  projectId: string;
  version: string;
  userId: string;
  agency: ActorAgency;
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
  if (input.agency === 'agent') {
    throw refuseRelease(
      'RELEASE_APPROVAL_IS_A_PERSONS',
      `a drafted release is decided by its listed approvers, the people who hold releases.approve, and this request carries an agent's token. Ask the approver with POST /api/questions, naming the project rule that asks for their approval in \`rule\`.`,
    );
  }
  const why = await draftNotApprovableWhy(projectId);
  if (why) throw refuseRelease('RELEASE_DRAFT_NOT_APPROVABLE', why, '/version');
  if (await runCutAs(projectId, version)) {
    throw refuseRelease(
      'RELEASE_DRAFT_NOT_APPROVABLE',
      `${version} is cut as a run, not a draft: its approval is asked on the run and decided there`,
      '/version',
    );
  }
  const drafted = await draftedVersion(projectId);
  if (drafted !== version) {
    throw refuseRelease(
      'RELEASE_VERSION_UNKNOWN',
      drafted === null
        ? `${version} is not drafted in this project: nothing waits at the release gate, so no release is drafted to decide`
        : `${version} is not the drafted release of this project; the draft is ${drafted}, and a decision names the version it decides`,
      '/version',
    );
  }
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
