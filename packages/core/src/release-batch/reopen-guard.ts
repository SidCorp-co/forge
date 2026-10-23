/**
 * Why the steward may not send an issue back from the release gate, by name, or null where it may.
 * Kernel input (`VISION: kernel-hard-policy-soft`), read by the steward's move door
 * (`steward/door-writes.ts`) before any reopen is sent, so its output check cannot talk its way past
 * a fact. Three facts each refuse a reopen at `awaiting_release`:
 *
 *   code                               the issue
 *   STEWARD_REOPEN_RELEASING           is a member of a release batch still running: its code ships
 *                                      with that release whatever its status says, so a reopen would
 *                                      leave it reading `reopen` over shipped code (forge-dev ISS-635,
 *                                      dev.287)
 *   STEWARD_REOPEN_COUNTED             stands on passes at its landing, with no production environment
 *                                      (`landed-build.ts:landedReopenRefusal`)
 *   STEWARD_REOPEN_JUDGED_AFTER_RELEASE is on a project whose document says its issues owe no verdict
 *                                      at the gate (`delivery.verdictsRequired: false`), and no failing
 *                                      verdict stands: a missing verdict there is the post-release
 *                                      judge's to write, not evidence that anything is wrong
 *
 * A failing verdict that stands is evidence on any project, so it never meets the third.
 */

import { verdictsRequiredOf } from '@forge/contracts/delivery-policy';
import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { issueDisplayIds, standingCriteriaOf } from '../issues/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { resolveReleaseDeclaration } from './gate.js';
import { landedReopenRefusal } from './landed-build.js';

export const STEWARD_REOPEN_RELEASING = 'STEWARD_REOPEN_RELEASING';
export const STEWARD_REOPEN_COUNTED = 'STEWARD_REOPEN_COUNTED';
export const STEWARD_REOPEN_JUDGED_AFTER_RELEASE = 'STEWARD_REOPEN_JUDGED_AFTER_RELEASE';

export interface ReopenRefusal {
  code: string;
  detail: string;
}

export async function stewardReopenRefusal(issueId: string): Promise<ReopenRefusal | null> {
  const [row] = await db
    .select({
      projectId: issues.projectId,
      status: issues.status,
      claim: issues.releaseBatchRunId,
      claimStatus: pipelineRuns.status,
    })
    .from(issues)
    .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  const key = (await issueDisplayIds([issueId])).get(issueId) ?? issueId;
  const releasing =
    row.claim !== null &&
    row.claimStatus !== null &&
    (LIVE_PIPELINE_RUN_STATUSES as readonly string[]).includes(row.claimStatus);
  if (releasing) {
    return {
      code: STEWARD_REOPEN_RELEASING,
      detail: `${key} is a member of release batch ${row.claim}, which is still ${row.claimStatus}: its code ships with that release whatever its status says, so a reopen now would leave it reading reopen over shipped code. Nothing is sent back mid-release; judge the build the release ships once it finishes, and reopen then with a failing verdict if one fails.`,
    };
  }
  const counted = await landedReopenRefusal(issueId);
  if (counted) return { code: STEWARD_REOPEN_COUNTED, detail: counted };
  const document = await readProjectDocument(row.projectId);
  if (verdictsRequiredOf(document?.document.delivery)) return null;
  const standing = (await standingCriteriaOf([issueId])).get(issueId);
  const failing = (standing?.criteria ?? []).filter((c) => c.verdict?.verdict === 'fail');
  if (failing.length > 0) return null;
  return {
    code: STEWARD_REOPEN_JUDGED_AFTER_RELEASE,
    detail: `${key}: this project's delivery policy says its issues owe no verdict at awaiting_release (delivery.verdictsRequired: false), so its criteria are judged on the build the release ships, by the judge that follows the release. A missing verdict or release proof here is owed after the release, not evidence for sending it back, and no failing verdict stands on it. Leave it at the gate; reopen it only over a criterion judged fail.`,
  };
}

/**
 * What the steward is told of the project's release and of the issue's place in it, as facts its
 * acts may not restate otherwise: whether a production environment exists and which, what the
 * delivery policy owes at the gate, and whether a live release batch claims the issue. dev.287's
 * output checks, given none of this, claimed "no production environment" on a project that has one.
 */
export async function stewardReleaseFacts(
  projectId: string,
  issueId: string | null,
): Promise<string> {
  const [declared, document] = await Promise.all([
    resolveReleaseDeclaration(projectId),
    readProjectDocument(projectId),
  ]);
  const where =
    declared?.kind === 'gated'
      ? `This project has a production environment, \`${declared.production.name}\`: its running build is what production serves, and a release batch deploys there and runs the release's checks.`
      : declared?.kind === 'change-requests'
        ? `This project deploys nothing and releases by merging its change requests${declared.defaultBranch ? ` into \`${declared.defaultBranch}\`` : ''}: a release is cut naming the issues, the owner approves it, and the master merges each request in the declared order; nothing merges before the approval.`
        : declared?.kind === 'no-release'
          ? `This project declares no production environment: its running build is each issue's landing${declared.defaultBranch ? ` on \`${declared.defaultBranch}\`` : ''}.`
          : `This project's release target is not declared${declared ? `: ${declared.reason}` : ''}.`;
  const owes = verdictsRequiredOf(document?.document.delivery)
    ? 'Its delivery policy owes a counting verdict on every criterion before release (delivery.verdictsRequired: true).'
    : 'Its delivery policy owes no verdict at awaiting_release (delivery.verdictsRequired: false): criteria are judged on the build the release ships, by the judge that follows the release, so a missing verdict or proof at the gate is not a reason to send an issue back.';
  const claim = issueId ? await liveClaimOf(issueId) : null;
  const member = claim
    ? `This issue is a member of release batch ${claim.run}, still ${claim.status}: nothing sends it back until that release finishes.`
    : null;
  return [where, owes, member].filter(Boolean).join('\n');
}

async function liveClaimOf(issueId: string): Promise<{ run: string; status: string } | null> {
  const [row] = await db
    .select({ run: issues.releaseBatchRunId, status: pipelineRuns.status })
    .from(issues)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row?.run || !(LIVE_PIPELINE_RUN_STATUSES as readonly string[]).includes(row.status)) {
    return null;
  }
  return { run: row.run, status: row.status };
}
