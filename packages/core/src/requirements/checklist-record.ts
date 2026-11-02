/**
 * What a requirement's own record answers to the requirement-ready checklist and the acceptance
 * checklist (`@forge/contracts/checklist-registry:REQUIREMENT_READY_CHECKLIST`,
 * `:REQUIREMENT_ACCEPTANCE_CHECKLIST`; Requirement lifecycle r15 ready_check, acceptance_check).
 * The kernel calls these under the requirement's lock, through the move's transaction; an agreed
 * requirement's accepted revision is read against the same ready checklist (`agree.ts`).
 *
 * Every sentence here is read by a person: the kernel refuses to judge with one that shows a record
 * field's key (`@forge/contracts/checklists:fieldKeyShownIn`).
 */

import type { RecordAnswer, RecordAnswers } from '@forge/contracts/checklists';
import { type GoalLabel, goalAnswers, goalLabelWords } from '@forge/contracts/requirement-goal';
import type { RequirementSpec } from '@forge/contracts/requirements';
import { EARNING_VERDICTS } from '@forge/contracts/verdict-identity';
import { CRITERION_STEPS_ROUTE, criterionStepsCall } from '@forge/contracts/workflow-health';
import { type WrittenLang, writtenLangOfText } from '@forge/contracts/written-lang';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  requirementCriteria,
  requirementCriterionSteps,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { openAmong } from '../questions/index.js';
import type { DeliveryProof } from './acceptance-rules.js';
import { requirementDependents } from './dependents.js';
import { linkedDesigns } from './read.js';

/** The longest record answer kept on a move: the record itself holds the whole text. */
const ANSWER_MAX = 300;

const clipped = (text: string) =>
  text.length <= ANSWER_MAX ? text : `${text.slice(0, ANSWER_MAX - 1).trimEnd()}…`;

/** How a gap names a label: the requirement's own word first, then the English one. */
const labelled = (lang: WrittenLang | null, label: GoalLabel) =>
  goalLabelWords(lang, label)
    .map((w) => `"${w}:"`)
    .join(' or ');

/** The fix for a label that stated nothing: its answer sits on the label's line or as a list under it. */
const LABEL_FIX =
  "Write it on the label's line, or as a list on the lines directly under it (no blank line between).";

/** What the head revision of a requirement holds, as the ready checklist reads it. */
export interface ReadyFacts {
  key: string;
  head: number | null;
  spec: RequirementSpec;
  kind: string | null;
  /** The codes of the business criteria live at the head. */
  criteria: string[];
  /** Blocking open questions still open, by their words and who answers them. */
  openBlocking: { question: string; whoAnswers: string }[];
  designs: { flow: string; approvedRevision: number | null }[];
  /** The live criteria (as `criteria`) tracing no step or link of any linked design. */
  untraced: string[];
  /** The language the head revision was written in; null where it was written before that was stored. */
  writtenLang: WrittenLang | null;
}

const goalGap = (
  what: string,
  fix = `Add a line to the goal that states ${what}.`,
): RecordAnswer => ({
  gap: `Its goal does not state ${what}.`,
  fix,
});

/**
 * Whether each live criterion traces a step or link of a linked design (ISS-691, REQ-65 BC-7): the
 * page's picture lights what the criteria touch, for every kind. It asks only over what is linked:
 * with no design or no criterion, the workflows or criteria question carries that gap, and this one
 * does not refuse a second time for it, nor ask for a trace nothing could hold.
 */
function tracedAnswer(f: ReadyFacts): RecordAnswer {
  const [design] = f.designs;
  if (!design) return { value: 'No linked workflow design to trace onto yet.' };
  if (f.criteria.length === 0) return { value: 'No business criterion to trace yet.' };
  if (f.untraced.length === 0) {
    return { value: clipped(`Each criterion traces its steps: ${f.criteria.join(', ')}.`) };
  }
  const n = f.untraced.length;
  return {
    gap: `${f.untraced.join(', ')} ${n === 1 ? 'traces' : 'trace'} no step or link of a linked workflow design.`,
    fix: `Trace ${n === 1 ? 'it' : 'each'} to the steps it touches on the requirement page, or with ${criterionStepsCall(f.key, design.flow)} per criterion; a trace with at least one step or link passes.`,
  };
}

/** The record answers of the ready checklist, from what the head revision holds. */
export function readyAnswersOf(f: ReadyFacts): RecordAnswers {
  if (f.head === null) {
    const none: RecordAnswer = {
      gap: `${f.key} has no current revision yet.`,
      fix: 'Write its first revision.',
    };
    return Object.fromEntries(
      [
        'problem',
        'kind',
        'who',
        'value',
        'measured',
        'criteria',
        'questions',
        'workflows',
        'traced',
        'outOfScope',
        'roadmap',
      ].map((q) => [q, none]),
    );
  }
  const lang = f.writtenLang ?? writtenLangOfText(f.spec.goal);
  const goal = goalAnswers(f.spec.goal, lang);
  const personas = (f.spec.personas ?? []).map((p) => p.trim()).filter(Boolean);
  const scopeOut = (f.spec.scopeOut ?? []).map((p) => p.trim()).filter(Boolean);
  const answer = (said: string | undefined, gap: RecordAnswer): RecordAnswer =>
    said ? { value: clipped(said) } : gap;
  return {
    problem: answer(
      goal.problem,
      goalGap(
        'the problem it solves',
        `Add a line to the goal that states it: a line of its own with no label, or after ${labelled(lang, 'problem')}.`,
      ),
    ),
    kind: f.kind
      ? { value: f.kind }
      : {
          gap: 'Its head revision names no kind.',
          fix: 'Set the kind, or leave it to be assumed.',
        },
    who: personas.length
      ? { value: clipped(personas.join(', ')) }
      : { gap: 'It names nobody it is for.', fix: 'Name at least one persona it is for.' },
    value: answer(
      goal.value,
      goalGap(`the value it gives, after ${labelled(lang, 'value')}`, LABEL_FIX),
    ),
    measured: answer(
      goal.measured,
      goalGap(`how success is measured, after ${labelled(lang, 'measured')}`, LABEL_FIX),
    ),
    criteria: f.criteria.length
      ? {
          value: `${f.criteria.length} ${f.criteria.length === 1 ? 'criterion' : 'criteria'}: ${f.criteria.join(', ')}`,
        }
      : {
          gap: `Revision ${f.head} holds no business criterion.`,
          fix: 'Write at least one checkable business criterion (BC-n).',
        },
    questions: f.openBlocking.length
      ? {
          gap: `${f.openBlocking.length === 1 ? 'A blocking question is' : `${f.openBlocking.length} blocking questions are`} still open: ${f.openBlocking
            .map((q) => `"${clipped(q.question)}" (answered by ${q.whoAnswers})`)
            .join('; ')}.`,
          fix: 'Answer each one, or write a revision that no longer marks it blocking.',
        }
      : { value: 'None open.' },
    workflows:
      f.designs.length === 0
        ? {
            gap: 'It links no workflow design.',
            fix: `Link each workflow design it changes or serves (POST /api/projects/:id/requirements/${f.key}/workflows { "workflowId": <design uuid> }), then trace each criterion to the steps it rests on (${CRITERION_STEPS_ROUTE}).`,
          }
        : {
            // an unapproved one is refused by the agree's own design guard (REQUIREMENT_DESIGN_UNAPPROVED)
            value: clipped(
              f.designs
                .map((d) =>
                  d.approvedRevision === null
                    ? `${d.flow}, not approved yet`
                    : `${d.flow} revision ${d.approvedRevision}`,
                )
                .join('; '),
            ),
          },
    traced: tracedAnswer(f),
    outOfScope: scopeOut.length
      ? { value: clipped(scopeOut.join('; ')) }
      : {
          gap: 'It states nothing out of scope.',
          fix: 'List what it leaves out, or leave it assumed.',
        },
    roadmap: answer(
      goal.roadmap,
      goalGap(`its roadmap lane, after ${labelled(lang, 'roadmap')}`, LABEL_FIX),
    ),
  };
}

type Reader = Pick<Tx, 'select' | 'execute'>;

/** The ready checklist's record answers for `requirementId` at its head, read through `tx`. */
export async function requirementReadyRecord(
  tx: Tx,
  requirementId: string,
): Promise<RecordAnswers> {
  return readyAnswersOf(await readyFactsIn(tx, requirementId));
}

export async function readyFactsIn(tx: Tx, requirementId: string): Promise<ReadyFacts> {
  const [row] = await tx
    .select({ reqSeq: requirements.reqSeq, head: requirements.currentRevision })
    .from(requirements)
    .where(eq(requirements.id, requirementId));
  if (!row)
    throw new Error(`requirement checklist: requirement ${requirementId} has no row to read`);
  const key = `REQ-${row.reqSeq}`;
  if (row.head === null) {
    return {
      key,
      head: null,
      spec: {},
      kind: null,
      criteria: [],
      openBlocking: [],
      designs: [],
      untraced: [],
      writtenLang: null,
    };
  }
  return readyFactsAt(tx, requirementId, key, row.head);
}

/** The ready facts of `revision`, which may be a proposed revision about to become the head. */
export async function readyFactsAt(
  tx: Tx,
  requirementId: string,
  key: string,
  revision: number,
): Promise<ReadyFacts> {
  const [rev] = await tx
    .select({
      spec: requirementRevisions.spec,
      kind: requirementRevisions.kind,
      writtenLang: requirementRevisions.writtenLang,
    })
    .from(requirementRevisions)
    .where(
      and(
        eq(requirementRevisions.requirementId, requirementId),
        eq(requirementRevisions.revision, revision),
      ),
    );
  if (!rev) throw new Error(`requirement checklist: ${key} has no revision ${revision} to read`);
  const spec = (rev.spec ?? {}) as RequirementSpec;
  const criteria = await liveCodesAt(tx, requirementId, revision);
  const blocking = (spec.openQuestions ?? []).filter((q) => q.blocking && q.questionId);
  const open = await openAmong(
    blocking.map((q) => q.questionId as string),
    tx,
  );
  const designs = await linkedDesigns(tx, requirementId);
  // a question holding the value check blocks the agree as any blocking question does (REQ-65 BC-4)
  const held = await requirementDependents().valueCheckHeld(tx, requirementId);
  return {
    key,
    head: revision,
    spec,
    kind: rev.kind ?? null,
    criteria,
    openBlocking: [
      ...blocking
        .filter((q) => open.has(q.questionId as string))
        .map((q) => ({ question: q.question, whoAnswers: q.whoAnswers })),
      ...held.map((question) => ({ question, whoAnswers: 'its author' })),
    ],
    designs: designs.map((d) => ({ flow: d.flow, approvedRevision: d.approvedRevision })),
    untraced: await untracedAmong(
      tx,
      requirementId,
      criteria,
      designs.map((d) => d.workflowId),
    ),
    writtenLang: rev.writtenLang ?? null,
  };
}

/** Which of `codes` trace no step or link of the designs `workflowIds`, the ones linked now. */
async function untracedAmong(
  exec: Pick<Tx, 'selectDistinct'>,
  requirementId: string,
  codes: readonly string[],
  workflowIds: readonly string[],
): Promise<string[]> {
  if (codes.length === 0 || workflowIds.length === 0) return [];
  const rows = await exec
    .selectDistinct({ code: requirementCriterionSteps.code })
    .from(requirementCriterionSteps)
    .where(
      and(
        eq(requirementCriterionSteps.requirementId, requirementId),
        inArray(requirementCriterionSteps.workflowId, [...workflowIds]),
      ),
    );
  const traced = new Set(rows.map((r) => r.code));
  return codes.filter((c) => !traced.has(c));
}

async function liveCodesAt(
  exec: Reader,
  requirementId: string,
  revision: number,
): Promise<string[]> {
  const rows = await exec
    .select({ code: requirementCriteria.code })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        sql`${requirementCriteria.sinceRevision} <= ${revision}`,
        sql`(${requirementCriteria.retiredRevision} IS NULL OR ${requirementCriteria.retiredRevision} > ${revision})`,
      ),
    );
  return rows.map((r) => r.code).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

/** A counted verdict on a requirement's issue that cites nothing, by issue and criterion number. */
export interface UncitedVerdict {
  issue: string;
  criterion: number;
}

/**
 * The latest pass or short on each live criterion of `requirementId`'s issues that cites no
 * evidence: verdicts written before citing was refused at the write (`messaging/evidence-citation.ts`).
 */
export async function uncitedVerdictsIn(
  exec: Reader,
  requirementId: string,
  issuePrefix: string | null,
): Promise<UncitedVerdict[]> {
  const rows = (await exec.execute(sql`
    SELECT i.iss_seq, c.n
      FROM issues i
      JOIN issue_criteria c ON c.issue_id = i.id AND c.retired_at IS NULL
      JOIN LATERAL (
        SELECT v.verdict, v.evidence FROM criterion_verdicts v
         WHERE v.criterion_id = c.id ORDER BY v.created_at DESC LIMIT 1
      ) latest ON true
     WHERE i.requirement_id = ${requirementId}
       AND i.status <> 'dropped'
       AND latest.verdict IN (${sql.join(
         EARNING_VERDICTS.map((v) => sql`${v}`),
         sql`, `,
       )})
       AND cardinality(latest.evidence) = 0
     ORDER BY i.iss_seq, c.n
  `)) as unknown as Array<{ iss_seq: number; n: number }>;
  return rows.map((r) => ({ issue: formatIssueRef(issuePrefix, r.iss_seq), criterion: r.n }));
}

/** The acceptance checklist's record answers, from the delivery read in the accept's transaction. */
export function acceptanceAnswersOf(
  proof: DeliveryProof,
  uncited: readonly UncitedVerdict[],
): RecordAnswers {
  return {
    // a requirement resting on its shipped capability has no issue to ship (ISS-588): whether that
    // capability holds is the verdicts question's, read on the running build
    shipped:
      proof.liveIssues === 0 && proof.shipped
        ? { value: 'No issue carries it: it rests on the capability already shipped.' }
        : proof.liveIssues === 0
          ? {
              gap: 'No live issue delivers it, so nothing was delivered.',
              fix: 'Break it down into issues, or judge each criterion where it already shipped.',
            }
          : proof.unshipped.length > 0
            ? {
                gap: `${proof.unshipped.join(', ')} ${proof.unshipped.length === 1 ? 'has' : 'have'} not shipped.`,
                fix: 'Wait for each to ship, or drop those not being built.',
              }
            : {
                value: `All ${proof.liveIssues} live ${proof.liveIssues === 1 ? 'issue' : 'issues'} shipped.`,
              },
    verdicts:
      proof.unproven.length > 0
        ? {
            gap: `Not passing on the running build: ${proof.unproven
              .map(
                (c) =>
                  `${c.code} (${c.verdict.replace('_', ' ')}${c.why ? `: ${clipped(c.why)}` : ''})`,
              )
              .join('; ')}.`,
            fix: 'Have each one judged on the running build.',
          }
        : { value: 'Every current criterion passes on the running build.' },
    evidence:
      uncited.length > 0
        ? {
            gap: `These verdicts cite nothing: ${uncited.map((u) => `${u.issue} criterion ${u.criterion}`).join(', ')}.`,
            fix: 'Judge each one again, citing what the verdict was taken from.',
          }
        : { value: 'Each counted verdict cites its evidence.' },
  };
}
