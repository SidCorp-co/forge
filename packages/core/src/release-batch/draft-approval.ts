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
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idOfParts, onePerId, onePerProject, partsOf } from '../db/read-memo.js';
import {
  type ReleaseDraftApprovalRow,
  releaseDraftApprovals,
} from '../db/schema-release-ledger.js';
import { peopleOf } from '../lib/people.js';
import { RefusalError } from '../lib/refusal.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, permissionRefusalFor, projectResource } from '../permissions/index.js';
import { readReleasePath } from '../project-config/index.js';
import type { Carry } from './approval-carry.js';
import { settledValue } from './blocker-kit.js';
import { draftedVersion } from './draft-version.js';
import { runCutAs } from './naming.js';
import { waitingIssueIds } from './queries.js';
import { refuseRelease } from './refuse.js';

type Decision =
  | { decision: 'approve'; reason?: string; carry?: Carry }
  | { decision: 'return'; reason: string };

/**
 * Who decides a release: a Forge user, whose releases.approve the door checks, or a decider a project
 * admin declared by chat identity (REQ-90 BC-15), whose declaration its caller checked: the identity's
 * account and the name the room showed. Each is recorded as itself, never as anyone else.
 */
export type ReleaseDecider =
  | { kind: 'person'; userId: string }
  | { kind: 'chat'; chatAccountId: string; name: string };

/** The decider's columns on a decision row. */
export const deciderColumns = (by: ReleaseDecider) =>
  by.kind === 'person'
    ? { decidedByUser: by.userId, decidedByChatAccount: null, decidedByChatName: null }
    : { decidedByUser: null, decidedByChatAccount: by.chatAccountId, decidedByChatName: by.name };

/** Refused where a person holds no releases.approve; a declared decider's declaration is its caller's. */
export async function deciderRefusal(projectId: string, by: ReleaseDecider): Promise<void> {
  if (by.kind === 'chat') return;
  const denied = await permissionRefusalFor(
    actorFor(by.userId),
    'releases.approve',
    projectResource(projectId),
    'approving or returning a release',
  );
  if (denied) throw new RefusalError([denied], denied.code);
}

/** Who decided a row, as a release reads a person: a declared chat decider reads by their name. */
async function decidedByOf(row: {
  decidedByUser: string | null;
  decidedByChatAccount: string | null;
  decidedByChatName: string | null;
}): Promise<{ id: string; name: string; kind: 'human' | 'agent' } | null> {
  if (row.decidedByChatAccount) {
    return {
      id: row.decidedByChatAccount,
      name: row.decidedByChatName ?? 'Unknown',
      kind: 'human',
    };
  }
  if (!row.decidedByUser) return null;
  const p = (await peopleOf([row.decidedByUser])).get(row.decidedByUser);
  return { id: row.decidedByUser, name: p?.name ?? 'Unknown', kind: p?.kind ?? 'human' };
}

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
  // the three are read at once and weighed in order, a later one's failure thrown only where it is
  // reached: a read of the draft waits on one wave, not three (ISS-1070 r17)
  const [why, cut, drafted] = await Promise.allSettled([
    draftNotApprovableWhy(projectId),
    runCutAs(projectId, version),
    draftedVersion(projectId),
  ]);
  const notApprovable = settledValue(why);
  if (notApprovable) return { code: 'RELEASE_DRAFT_NOT_APPROVABLE', why: notApprovable };
  if (settledValue(cut)) {
    return {
      code: 'RELEASE_DRAFT_NOT_APPROVABLE',
      why: `${version} is cut as a run, not a draft: its approval is asked on the run and decided there`,
    };
  }
  const draft = settledValue(drafted);
  if (draft === version) return null;
  return {
    code: 'RELEASE_VERSION_UNKNOWN',
    why:
      draft === null
        ? `${version} is not drafted in this project: nothing waits at the release gate, so no release is drafted to decide`
        : `${version} is not the drafted release of this project; the draft is ${draft}, and a decision names the version it decides`,
  };
}

async function viewOf(row: ReleaseDraftApprovalRow): Promise<ReleaseDraftApprovalView> {
  // the row's check names exactly one decider
  const decidedBy = (await decidedByOf(row)) ?? { id: '', name: 'Unknown', kind: 'human' as const };
  return {
    id: row.id,
    version: row.version,
    decision: row.decision,
    decidedBy,
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
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const latest = await onePerId('draftApproval', idOfParts(projectId, version), latestDecisionsOf);
  if (!latest || !sameRoster(latest.issueIds, roster)) return null;
  return viewOf(latest);
}

/** The newest decision on each project and version named (`idOfParts`). */
async function latestDecisionsOf(keys: readonly string[]) {
  const pairs = keys.map((k) => partsOf(k));
  const rows = await db
    .selectDistinctOn([releaseDraftApprovals.projectId, releaseDraftApprovals.version])
    .from(releaseDraftApprovals)
    .where(
      or(
        ...pairs.map(([projectId = '', version = '']) =>
          and(
            eq(releaseDraftApprovals.projectId, projectId),
            eq(releaseDraftApprovals.version, version),
          ),
        ),
      ),
    )
    .orderBy(
      releaseDraftApprovals.projectId,
      releaseDraftApprovals.version,
      desc(releaseDraftApprovals.decidedAt),
      desc(releaseDraftApprovals.id),
    );
  return new Map(rows.map((r) => [idOfParts(r.projectId, r.version), r]));
}

/**
 * Whether an approver's standing decision approves exactly this roster (ISS-1075): the latest draft
 * decision on the project, read whatever version it named, approves when it is `approved` and was
 * given for the same issues. What waited on a required approval reads it.
 */
export async function rosterApproved(
  projectId: string,
  roster: readonly string[],
): Promise<boolean> {
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const latest = await onePerProject('latestDraftDecision', projectId, async (ids) => {
    const rows = await db
      .selectDistinctOn([releaseDraftApprovals.projectId])
      .from(releaseDraftApprovals)
      .where(inArray(releaseDraftApprovals.projectId, [...ids]))
      .orderBy(
        releaseDraftApprovals.projectId,
        desc(releaseDraftApprovals.decidedAt),
        desc(releaseDraftApprovals.id),
      );
    return new Map(rows.map((r) => [r.projectId, r]));
  });
  return !!latest && latest.decision === 'approved' && sameRoster(latest.issueIds, roster);
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
  return decideDraftApprovalBy({ ...input, by: { kind: 'person', userId: input.userId } });
}

/** `decideDraftApproval` by either decider (`ReleaseDecider`). */
export async function decideDraftApprovalBy(input: {
  projectId: string;
  version: string;
  by: ReleaseDecider;
  decision: Decision;
}): Promise<ReleaseDraftApprovalView> {
  const { projectId, version, by, decision } = input;
  await deciderRefusal(projectId, by);
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
  // the decision settles its approver's Needs you row, which the workspace's Activity hears (ISS-1075)
  const row = await db.transaction(async (tx) => {
    const [written] = await tx
      .insert(releaseDraftApprovals)
      .values({
        projectId,
        version,
        issueIds: roster,
        decision: decision.decision === 'approve' ? 'approved' : 'returned',
        ...deciderColumns(by),
        reason: decision.reason?.trim() || null,
      })
      .returning();
    await emitEvent(tx, 'decision.settled', {
      projectId,
      act: 'release.decideDraft',
      subject: version,
    });
    return written;
  });
  if (!row) throw new Error('release-batch: the draft decision was not written');
  return viewOf(row);
}
