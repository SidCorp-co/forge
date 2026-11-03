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
  type ChecklistEvaluation,
  type ChecklistRefusal,
  checklistRefusals,
  evaluateChecklist,
  parseAnswers,
  type RecordAnswer,
  type RecordAnswers,
} from '@forge/contracts/checklists';
import { projectGate } from '@forge/contracts/gate-profiles';
import { CRITERION_STANDING_LABELS } from '@forge/contracts/issue-vocabulary';
import type { Refusal } from '@forge/contracts/refusal';
import { reviewPassOwedWhy } from '@forge/contracts/release-page';
import type { ReleaseCarriedCriterion } from '@forge/contracts/releases';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { readProjectDocument } from '../project-config/index.js';
import { type Carry, resolveCarry } from './approval-carry.js';
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

/** What clears the unproven criteria: a judge's pass on what the release ships, and on a code
 *  property, which only the review judges, a review's pass on the diff (ISS-914). */
function verdictsFix(f: Pick<ApprovalFacts, 'unproven' | 'judgedOn'>): string {
  const reviewOwed = f.unproven.some((u) => u.standing === reviewPassOwedWhy);
  const judgeOwed = f.unproven.some((u) => u.standing !== reviewPassOwedWhy);
  const judge =
    f.judgedOn === null
      ? "Have the project's judge pass each on the commit it ships."
      : `Deploy the commit it ships to ${f.judgedOn}, and have the project's judge pass each there, on the build ${f.judgedOn} serves.`;
  const review = 'Have a reviewer run pass each code property on the diff.';
  return [judgeOwed ? judge : null, reviewOwed ? review : null].filter(Boolean).join(' ');
}

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
          fix: verdictsFix(f),
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

/** The approval facts, with every criterion the release holds, which a carry is resolved against. */
export interface ReleaseApprovalFacts extends ApprovalFacts {
  criteria: { issue: string; n: number }[];
}

/** What the release `runId` carries, read for its approval at `build`, the commit it ships. */
export async function approvalFactsOf(
  projectId: string,
  runId: string,
  build: string,
): Promise<ReleaseApprovalFacts> {
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
    criteria: ordered.flatMap((i) => i.criteria.map((c) => ({ issue: i.key, n: c.n }))),
    verdictsRequired: projectGate(doc?.document, null, 'release_criteria').mode === 'enforce',
    judgedOn: facts.judgedOn,
  };
}

const keyOf = (c: { issue: string; n: number }) => `${c.issue}#${c.n}`;

/**
 * The evaluation with the verdicts gap the approver carried as a `waived` answer: its value names
 * each carried criterion with its standing and the approver's why, and its source is the carry.
 */
function carriedEvaluation(
  evaluation: ChecklistEvaluation,
  carried: readonly ReleaseCarriedCriterion[],
): ChecklistEvaluation {
  if (carried.length === 0 || !evaluation.gaps.some((g) => g.question === 'verdicts'))
    return evaluation;
  const gaps = evaluation.gaps.filter((g) => g.question !== 'verdicts');
  return {
    ...evaluation,
    complete: gaps.length === 0,
    gaps,
    answers: [
      ...evaluation.answers,
      {
        question: 'verdicts',
        value:
          `Carried unproven: ${carried.map((c) => `${c.issue} criterion ${c.n} (${c.standing}): ${c.why}`).join('; ')}.`.slice(
            0,
            2000,
          ),
        provenance: 'waived',
        source: 'decision:carry',
      },
    ],
  };
}

/**
 * The refusals approving the release `runId` meets, and the criteria its approver carried: each
 * gap the checklist names, on the body's `reason` where the approver's own answer is what is
 * missing; each carry entry naming a proven or unknown criterion, on its own path. A criterion left
 * unproven and not carried is still the verdicts gap, naming only what was not carried.
 */
export async function approvalChecklistRefusals(
  projectId: string,
  runId: string,
  build: string,
  reason: string | undefined,
  carry?: Carry,
): Promise<{ refusals: Refusal[]; carried: ReleaseCarriedCriterion[] }> {
  const facts = await approvalFactsOf(projectId, runId, build);
  const resolved = carry ? resolveCarry(carry, facts) : { carried: [], refusals: [] };
  if (resolved.refusals.length > 0) return { refusals: resolved.refusals, carried: [] };
  const given = parseAnswers(RELEASE_APPROVAL_CHECKLIST, reason === undefined ? {} : { reason });
  if (!given.ok)
    return { refusals: given.refusals.map((r) => ({ ...r, path: '/reason' })), carried: [] };
  const carriedKeys = new Set(resolved.carried.map(keyOf));
  const owed = facts.unproven.filter((u) => !carriedKeys.has(keyOf(u)));
  const evaluated = evaluateChecklist(RELEASE_APPROVAL_CHECKLIST, {
    given: given.answers,
    // what is still owed names the gap; where nothing is, the full list reads as the gap the carry waives
    record: approvalAnswersOf(owed.length > 0 ? { ...facts, unproven: owed } : facts),
  });
  const judged = owed.length > 0 ? evaluated : carriedEvaluation(evaluated, resolved.carried);
  const refusals: ChecklistRefusal[] = checklistRefusals(judged).map((r) =>
    r.question === 'reason' ? { ...r, path: '/reason' } : r,
  );
  return { refusals, carried: refusals.length > 0 ? [] : resolved.carried };
}
