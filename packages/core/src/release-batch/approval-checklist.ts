/**
 * What a release answers to the release approval checklist
 * (`@forge/contracts/checklist-registry:RELEASE_APPROVAL_CHECKLIST`, Requirement lifecycle r15
 * release_check) when its approver approves it: the requirements it carries, each at its revision,
 * and each carried criterion as proven or not on the commit it ships, by the verified rule every count
 * of proof reads (`release-facts.ts:criteriaAt`, contracts `verified-rule.ts:verifiedOf`): a short, or the
 * builder's own pass, is not proven, and the gap says why. A project naming its testing environment
 * (`delivery.judgedOn`, REQ-36 BC-18) proves each only by a pass judged on the build that environment
 * serves, so its owner reviews what ran there, never a commit judged elsewhere. A project whose document says
 * `delivery.verdictsRequired: false` judges on the running build after release, so its verdicts are
 * not asked here.
 *
 * Every sentence here is read by a person: a sentence showing a record field's key is refused
 * (`@forge/contracts/checklists:fieldKeyShownIn`).
 */

import { RELEASE_APPROVAL_CHECKLIST } from '@forge/contracts/checklist-registry';
import {
  type ChecklistRefusal,
  checklistRefusals,
  evaluateChecklist,
  parseAnswers,
  type RecordAnswer,
  type RecordAnswers,
} from '@forge/contracts/checklists';
import { verdictsRequiredOf } from '@forge/contracts/delivery-policy';
import { CRITERION_STANDING_LABELS } from '@forge/contracts/issue-vocabulary';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { readProjectDocument } from '../project-config/index.js';
import { type ChangeRequestBuild, changeRequestBuildsOf } from './change-request-build.js';
import { mergeStepsOf } from './change-request-roster.js';
import { criteriaAt, loadReleaseFacts } from './release-facts.js';

export interface ApprovalFacts {
  /** Each carried issue by its key, the requirement it serves at that requirement's revision. */
  carried: { issue: string; requirement: { key: string; revision: number | null } | null }[];
  /** Every carried criterion not proven, with its standing's words, or why its pass or short does not count. */
  unproven: { issue: string; n: number; standing: string }[];
  verdictsRequired: boolean;
  /** The testing environment a carried criterion is proven on (REQ-36 BC-18); null where a commit verdict counts. */
  judgedOn: string | null;
}

const listed = (items: readonly string[]) => items.join(', ');

/** The record answers of the release approval checklist, from what the release carries. */
export function approvalAnswersOf(f: ApprovalFacts): RecordAnswers {
  const carried: RecordAnswer =
    f.carried.length === 0
      ? { gap: 'It carries no issue.', fix: 'Cut the release again from issues that landed.' }
      : (() => {
          const reqs = new Map<string, number | null>();
          for (const c of f.carried)
            if (c.requirement) reqs.set(c.requirement.key, c.requirement.revision);
          const none = f.carried.filter((c) => !c.requirement).map((c) => c.issue);
          return {
            value: [
              reqs.size > 0
                ? [...reqs]
                    .map(([key, rev]) =>
                      rev === null ? `${key} with no agreed revision` : `${key} at revision ${rev}`,
                    )
                    .join('; ')
                : null,
              none.length > 0
                ? `${listed(none)} ${none.length === 1 ? 'serves' : 'serve'} no requirement`
                : null,
            ]
              .filter(Boolean)
              .join('; ')
              .concat('.')
              .slice(0, 2000),
          };
        })();
  const verdicts: RecordAnswer = !f.verdictsRequired
    ? { value: 'Not asked: this project judges criteria on the running build after release.' }
    : f.unproven.length > 0
      ? {
          gap: `Not proven: ${f.unproven.map((u) => `${u.issue} criterion ${u.n} (${u.standing})`).join('; ')}.`.slice(
            0,
            2000,
          ),
          fix:
            f.judgedOn === null
              ? "Have the project's judge pass each on the commit it ships."
              : `Deploy the commit it ships to ${f.judgedOn}, and have the project's judge pass each there, on the build ${f.judgedOn} serves.`,
        }
      : { value: 'Every carried criterion is proven.' };
  return { carried, verdicts };
}

/**
 * Each issue's build on a release that merges change requests: the head of the request delivering
 * it, cut at, while it is unchanged — or why it no longer counts (`change-request-build.ts`, REQ-63
 * BC-6). Empty for any other release, which ships one commit.
 */
async function changeRequestBuildsFor(
  projectId: string,
  runId: string,
  ids: readonly string[],
): Promise<Map<string, ChangeRequestBuild>> {
  const [run] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  if (!mergeStepsOf(run?.metadata)) return new Map();
  return changeRequestBuildsOf(projectId, ids);
}

/** What the release `runId` carries, read for its approval at `build`, the commit it ships. */
export async function approvalFactsOf(
  projectId: string,
  runId: string,
  build: string,
): Promise<ApprovalFacts> {
  const rows = await db
    .select({ id: issues.id, requirementId: issues.requirementId })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.releaseBatchRunId, runId)));
  const ids = rows.map((r) => r.id);
  const reqIds = [...new Set(rows.flatMap((r) => (r.requirementId ? [r.requirementId] : [])))];
  const [facts, reqs, doc, crBuilds] = await Promise.all([
    loadReleaseFacts(projectId, ids, [runId]),
    reqIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: requirements.id,
            seq: requirements.reqSeq,
            revision: requirements.currentRevision,
          })
          .from(requirements)
          .where(inArray(requirements.id, reqIds)),
    readProjectDocument(projectId),
    changeRequestBuildsFor(projectId, runId, ids),
  ]);
  const reqOf = new Map(
    reqs.map((r) => [r.id, { key: requirementKey(r.seq), revision: r.revision }]),
  );
  const ordered = [...facts.issues.values()].sort((a, b) =>
    a.key.localeCompare(b.key, 'en', { numeric: true }),
  );
  return {
    carried: ordered.map((i) => ({
      issue: i.key,
      requirement: i.requirementId ? (reqOf.get(i.requirementId) ?? null) : null,
    })),
    unproven: ordered.flatMap((i) => {
      const cr = crBuilds.get(i.id);
      // a request whose head moved since the cut: none of its verdicts counts, and that is the gap
      if (cr && cr.sha === null) {
        // a person reads this sentence beside the issue's key: no code formatting, no repeated key
        const why = cr.why.replace(`${i.key}: `, '').replaceAll('`', '');
        return i.criteria.map((c) => ({ issue: i.key, n: c.n, standing: why }));
      }
      return criteriaAt(i, cr?.sha ?? build, facts)
        .filter((c) => !c.proven)
        .map((c) => ({
          issue: i.key,
          n: c.n,
          standing: c.unverified ?? CRITERION_STANDING_LABELS[c.standing].toLowerCase(),
        }));
    }),
    verdictsRequired: verdictsRequiredOf(doc?.document.delivery),
    judgedOn: facts.judgedOn,
  };
}

/**
 * The refusals approving the release `runId` meets: each gap the checklist names, on the body's
 * `reason` where the approver's own answer is what is missing.
 */
export async function approvalChecklistRefusals(
  projectId: string,
  runId: string,
  build: string,
  reason: string | undefined,
): Promise<ChecklistRefusal[]> {
  const given = parseAnswers(RELEASE_APPROVAL_CHECKLIST, reason === undefined ? {} : { reason });
  if (!given.ok) return given.refusals.map((r) => ({ ...r, path: '/reason' }));
  const judged = evaluateChecklist(RELEASE_APPROVAL_CHECKLIST, {
    given: given.answers,
    record: approvalAnswersOf(await approvalFactsOf(projectId, runId, build)),
  });
  return checklistRefusals(judged).map((r) =>
    r.question === 'reason' ? { ...r, path: '/reason' } : r,
  );
}
