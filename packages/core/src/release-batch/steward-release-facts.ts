/**
 * The facts the steward's acts read about an issue at the release gate, which it may not restate
 * otherwise: where its running build is, what the delivery policy owes, whether a live release batch
 * claims it, its head on a change-request project, and on a project with no production environment
 * whether its landed work is missing nothing or which verdicts it still owes at the landing. The
 * steward moves no issue back (`steward/door-writes.ts`): what an issue lacks goes in its note.
 */

import { verdictsRequiredOf } from '@forge/contracts/delivery-policy';
import { LIVE_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { issueWorkState } from '../db/schema-issue-work-state.js';
import { readProjectDocument } from '../project-config/index.js';
import { resolveReleaseDeclaration } from './gate.js';
import { deliveryHeadsOf } from './landed-build.js';
import { landedCompleteFact, landedVerdictsOwedFact } from './landed-facts.js';

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
        ? `This project deploys nothing and releases by merging its change requests${declared.defaultBranch ? ` into \`${declared.defaultBranch}\`` : ''}: a release is cut naming the issues, the owner approves it, and the master merges each request in the declared order; nothing merges before the approval. Until its request merges, an issue's running build is that request's head: a pass judged there counts while the head is unchanged, and no landing is owed. Work the host already holds on that branch with no request is landed there and needs no request.`
        : declared?.kind === 'no-release'
          ? `This project declares no production environment: its running build is each issue's landing${declared.defaultBranch ? ` on \`${declared.defaultBranch}\`` : ''}.`
          : `This project's release target is not declared${declared ? `: ${declared.reason}` : ''}.`;
  const owes = verdictsRequiredOf(document?.document.delivery)
    ? 'Its delivery policy owes a counting verdict on every criterion before release (delivery.verdictsRequired: true).'
    : 'Its delivery policy owes no verdict at awaiting_release (delivery.verdictsRequired: false): criteria are judged on the build the release ships, by the judge that follows the release, so a missing verdict or proof at the gate is not a reason to send an issue back.';
  const claim = issueId ? await liveClaimOf(issueId) : null;
  const member = claim
    ? `This issue is a member of release batch ${claim.run}, still ${claim.status}: its code ships with that release whatever its status says.`
    : null;
  const head = issueId ? await headFact(projectId, issueId) : null;
  const landed = issueId
    ? ((await landedCompleteFact(issueId)) ?? (await landedVerdictsOwedFact(issueId)))
    : null;
  return [where, owes, member, head, landed].filter(Boolean).join('\n');
}

/**
 * On a change-request project, the issue's head as the one predicate reads it, beside the run's
 * worklog capture of its work branch where that names another commit, so the capture is never read
 * as the head a verdict counts on (adminhub-api ISS-10, dev.296).
 */
async function headFact(projectId: string, issueId: string): Promise<string | null> {
  const head = (await deliveryHeadsOf(projectId, [issueId]))?.get(issueId.toLowerCase());
  if (!head) return null;
  const [capture] = await db
    .select({ branch: issueWorkState.branch, sha: issueWorkState.headSha })
    .from(issueWorkState)
    .where(eq(issueWorkState.issueId, issueId))
    .limit(1);
  const theirs =
    capture?.sha && capture.sha !== head.sha
      ? ` Its work state's \`${capture.branch ?? 'branch'}\` at \`${capture.sha.slice(0, 12)}\` is a run's worklog capture, not the head of this issue: never read it as one, nor ask for a verdict there.`
      : '';
  return `This issue's head: ${head.basis}.${theirs}`;
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
