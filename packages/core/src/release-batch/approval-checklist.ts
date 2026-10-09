/**
 * What a release answers to the release approval checklist
 * (`@forge/contracts/checklist-registry:RELEASE_APPROVAL_CHECKLIST`, Requirement lifecycle r15
 * release_check) when its approver approves it: the requirements it carries, each at its revision,
 * and each carried criterion's latest verdict on the commit it ships, read from the same facts the
 * release page counts by (`release-facts.ts`). A project whose document says
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
import {
  CRITERION_STANDING_LABELS,
  criterionCountsAsPass,
} from '@forge/contracts/issue-vocabulary';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { readProjectDocument } from '../project-config/index.js';
import { criteriaAt, loadReleaseFacts } from './release-facts.js';

export interface ApprovalFacts {
  /** Each carried issue by its key, the requirement it serves at that requirement's revision. */
  carried: { issue: string; requirement: { key: string; revision: number | null } | null }[];
  /** Every carried criterion that does not count as a pass, with its standing's words. */
  unpassed: { issue: string; n: number; standing: string }[];
  verdictsRequired: boolean;
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
    : f.unpassed.length > 0
      ? {
          gap: `Not a pass: ${f.unpassed.map((u) => `${u.issue} criterion ${u.n} (${u.standing})`).join('; ')}.`.slice(
            0,
            2000,
          ),
          fix: 'Have each one judged on the commit it ships; a fail is filed as feedback.',
        }
      : { value: 'Every carried criterion passes.' };
  return { carried, verdicts };
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
  const [facts, reqs, doc] = await Promise.all([
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
    unpassed: ordered.flatMap((i) =>
      criteriaAt(i, build)
        .filter((c) => !criterionCountsAsPass(c.standing))
        .map((c) => ({
          issue: i.key,
          n: c.n,
          standing: CRITERION_STANDING_LABELS[c.standing].toLowerCase(),
        })),
    ),
    verdictsRequired: verdictsRequiredOf(doc?.document.delivery),
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
