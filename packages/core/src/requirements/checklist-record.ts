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
import type { RequirementSpec } from '@forge/contracts/requirements';
import { EARNING_VERDICTS } from '@forge/contracts/verdict-identity';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { openAmong } from '../questions/index.js';
import type { DeliveryProof } from './acceptance-rules.js';
import { linkedDesigns } from './read.js';

/** The longest record answer kept on a move: the record itself holds the whole text. */
const ANSWER_MAX = 300;

const clipped = (text: string) =>
  text.length <= ANSWER_MAX ? text : `${text.slice(0, ANSWER_MAX - 1).trimEnd()}…`;

const GOAL_LABELS = {
  problem: /^problem\s*:\s*/i,
  value: /^value\s*:\s*/i,
  measured: /^measured by\s*:\s*/i,
  roadmap: /^roadmap\s*:\s*/i,
} as const;
type GoalLabel = keyof typeof GOAL_LABELS;

/**
 * The goal's labelled lines (`Problem:`, `Value:`, `Measured by:`, `Roadmap:`). A goal that labels
 * none of them states its problem as a whole, so its text answers the problem and nothing else.
 */
export function goalAnswers(goal: string | null | undefined): Partial<Record<GoalLabel, string>> {
  const text = goal?.trim() ?? '';
  if (text === '') return {};
  const found: Partial<Record<GoalLabel, string>> = {};
  for (const line of text.split('\n').map((l) => l.trim())) {
    for (const [label, pattern] of Object.entries(GOAL_LABELS) as [GoalLabel, RegExp][]) {
      if (found[label] === undefined && pattern.test(line)) {
        const said = line.replace(pattern, '').trim();
        if (said !== '') found[label] = said;
      }
    }
  }
  const labelled = text
    .split('\n')
    .some((l) => Object.values(GOAL_LABELS).some((p) => p.test(l.trim())));
  return labelled ? found : { problem: text };
}

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
}

const goalGap = (what: string): RecordAnswer => ({
  gap: `Its goal does not state ${what}.`,
  fix: `Add a line to the goal that states ${what}.`,
});

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
        'outOfScope',
        'roadmap',
      ].map((q) => [q, none]),
    );
  }
  const goal = goalAnswers(f.spec.goal);
  const personas = (f.spec.personas ?? []).map((p) => p.trim()).filter(Boolean);
  const scopeOut = (f.spec.scopeOut ?? []).map((p) => p.trim()).filter(Boolean);
  const answer = (said: string | undefined, gap: RecordAnswer): RecordAnswer =>
    said ? { value: clipped(said) } : gap;
  return {
    problem: answer(goal.problem, goalGap('the problem it solves, after "Problem:"')),
    kind: f.kind
      ? { value: f.kind }
      : {
          gap: 'Its head revision names no kind.',
          fix: 'Set the kind, or leave it to be assumed.',
        },
    who: personas.length
      ? { value: clipped(personas.join(', ')) }
      : { gap: 'It names nobody it is for.', fix: 'Name at least one persona it is for.' },
    value: answer(goal.value, goalGap('the value it gives, after "Value:"')),
    measured: answer(goal.measured, goalGap('how success is measured, after "Measured by:"')),
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
            fix: 'Link each workflow design it changes or serves.',
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
    outOfScope: scopeOut.length
      ? { value: clipped(scopeOut.join('; ')) }
      : {
          gap: 'It states nothing out of scope.',
          fix: 'List what it leaves out, or leave it assumed.',
        },
    roadmap: answer(goal.roadmap, goalGap('its roadmap lane, after "Roadmap:"')),
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
    return { key, head: null, spec: {}, kind: null, criteria: [], openBlocking: [], designs: [] };
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
    .select({ spec: requirementRevisions.spec, kind: requirementRevisions.kind })
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
  return {
    key,
    head: revision,
    spec,
    kind: rev.kind ?? null,
    criteria,
    openBlocking: blocking
      .filter((q) => open.has(q.questionId as string))
      .map((q) => ({ question: q.question, whoAnswers: q.whoAnswers })),
    designs: designs.map((d) => ({ flow: d.flow, approvedRevision: d.approvedRevision })),
  };
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
    shipped:
      proof.liveIssues === 0
        ? {
            gap: 'No live issue delivers it, so nothing was delivered.',
            fix: 'Break it down into issues first.',
          }
        : proof.unshipped.length > 0
          ? {
              gap: `${proof.unshipped.join(', ')} ${proof.unshipped.length === 1 ? 'has' : 'have'} not shipped.`,
              fix: 'Wait for a release to ship each one, or drop those not being built.',
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
            fix: 'Have each one judged on the running build; a fail is filed as feedback.',
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
