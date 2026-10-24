/**
 * Verdicts recorded on a requirement's business criteria at the requirement itself (ISS-588, REQ-74
 * BC-4, BC-5): how a capability that already shipped is proven on the running build without an issue
 * whose only work is verifying it (REQ-45 r3 BC-8). The write is refused by name
 * (`verdict-rules.ts`); each row is read into the criterion's coverage (`standing-coverage.ts`), so
 * it reads with the requirement's standing, and listed on its own.
 */

import {
  type RecordRequirementVerdictRequest,
  type RequirementCoverage,
  type RequirementVerdictRow,
  requirementKey,
} from '@forge/contracts/requirements';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementCriterionVerdicts } from '../db/schema-requirement-verdicts.js';
import { requirementCriteria } from '../db/schema-requirements.js';
import { peopleOf } from '../lib/people.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type RequirementActor, rowIn } from './read.js';
import { liveAt, type RequirementRefusal } from './rules.js';
import { requirementVerdictsOf } from './standing-facts.js';
import { standingsOf } from './standing-read.js';
import { requirementVerdictRefusals } from './verdict-rules.js';

export type RecordedVerdict =
  | { ok: true; verdictId: string; coverage: RequirementCoverage }
  | { ok: false; refusals: RequirementRefusal[] };

/**
 * Records one judgement of a business criterion on the running build, as its writer (project.write,
 * like a verdict on an issue criterion), and answers the criterion's coverage as the standing now
 * reads it, so the writer sees at once whether it counts.
 */
export async function recordRequirementVerdict(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  deviceId: string | null;
  body: RecordRequirementVerdictRequest;
}): Promise<RecordedVerdict> {
  const { projectId, actor, body } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const criteria = await db
    .select()
    .from(requirementCriteria)
    .where(eq(requirementCriteria.requirementId, row.id));
  const judged = requirementVerdictRefusals({
    key: requirementKey(row.reqSeq),
    status: row.status,
    live: row.currentRevision === null ? [] : liveAt(criteria, row.currentRevision),
    body,
  });
  if ('refusals' in judged) return { ok: false, refusals: judged.refusals };
  const [written] = await db
    .insert(requirementCriterionVerdicts)
    .values({
      requirementId: row.id,
      requirementCriterionId: judged.criterion.id,
      verdict: body.verdict as RequirementVerdictRow['verdict'],
      reason: body.reason?.trim() || null,
      evidence: [...(body.evidence ?? [])],
      commitSha: body.verdict === 'skipped' ? null : (body.identity?.sha.toLowerCase() ?? null),
      authorUserId: actor.userId,
      authorDeviceId: input.deviceId,
      authorAgency: actor.agency,
    })
    .returning({ id: requirementCriterionVerdicts.id });
  if (!written) throw new Error(`requirements: the verdict on ${row.id} was not written`);
  const standing = (await standingsOf(projectId, [row], null)).get(row.id);
  const coverage = standing?.coverage.find((c) => c.code === judged.criterion.code);
  if (!coverage) {
    throw new Error(
      `requirements: ${judged.criterion.code} of ${row.id} has no coverage after its verdict`,
    );
  }
  return { ok: true, verdictId: written.id, coverage };
}

/** Every verdict recorded at the requirement, newest first, each naming the criterion it judged. */
export async function listRequirementVerdicts(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
}): Promise<RequirementVerdictRow[]> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const [verdicts, criteria] = await Promise.all([
    requirementVerdictsOf([row.id]),
    db
      .select({ id: requirementCriteria.id, code: requirementCriteria.code })
      .from(requirementCriteria)
      .where(eq(requirementCriteria.requirementId, row.id)),
  ]);
  const people = await peopleOf(verdicts.map((v) => v.authorUserId));
  const codes = new Map(criteria.map((c) => [c.id, c.code]));
  return verdicts.map((v) => ({
    id: v.id,
    criterion: codes.get(v.requirementCriterionId) ?? '',
    verdict: v.verdict,
    reason: v.note,
    evidence: [...v.evidence],
    commit: v.commit,
    by: v.authorUserId
      ? {
          id: v.authorUserId,
          name: people.get(v.authorUserId)?.name ?? null,
          agency: v.authorAgency,
        }
      : null,
    at: v.verdictAt.toISOString(),
  }));
}
