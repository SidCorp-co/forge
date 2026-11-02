/**
 * What a requirement owes before its delivery starts (REQ-67 BC-1..BC-5): the questions still open
 * about it, the gaps the kernel can see, and whether the steward has checked it since its head was
 * agreed. One read serves the move's guard, which refuses naming each open question and a missing
 * check at once (`REQUIREMENT_CHECKED_GUARD`), the requirement's read and the steward's check, which
 * turns the gaps into the questions it needs about the requirement.
 *
 * A gap is a fact, never a judgement: whether each criterion can be checked on the running product
 * is the steward's to judge, and it asks about what it finds.
 * - `no_workflow` only where the project draws workflows: a project with none is not frozen by them.
 * - `untraced_workflow`: a linked workflow no live criterion traces a step of, so its picture lights
 *   nothing.
 * - `conflict` and `duplicate`: a link the intake draft wrote to a live requirement, settled once a
 *   decision recorded on this requirement after the draft names that requirement (an answered
 *   question reaches it as one), or once the linked requirement has ended; a conflict also once the
 *   criterion it quoted is no longer live there.
 */

import type {
  DeliveryCheckQuestion,
  DeliveryGap,
  RequirementDeliveryCheck,
} from '@forge/contracts/delivery-check';
import { REQUIREMENT_LIFECYCLE, requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { readProjectDocument } from '../project-config/index.js';
import type { RequirementRefusal } from './rules.js';

/** The requirement the check reads: its id, key and head. */
export interface CheckedRow {
  id: string;
  projectId: string;
  reqSeq: number;
  currentRevision: number | null;
}

/** Whether the project's steward is on, read before the move's lock: on unless its document says otherwise. */
export async function stewardOn(projectId: string): Promise<boolean> {
  return (await readProjectDocument(projectId))?.document.steward?.enabled ?? true;
}

/** A linked requirement still on the lifecycle line; dropped, deferred and refused have ended. */
const liveStatus = (s: string) => (REQUIREMENT_LIFECYCLE as readonly string[]).includes(s);

/**
 * The questions open about it: each asked of it or about it that a person or the master owes (outside
 * strict the master answers them, `questions/owed.ts`), but one its revisions
 * list as not blocking, and each question
 * comment a steward check posted before ISS-688 that nobody but the steward has replied to (the
 * amnesty `steward/holds.ts` prices; no new one is written).
 */
async function openQuestions(tx: Tx, row: CheckedRow): Promise<DeliveryCheckQuestion[]> {
  const rows = rowsOf<{ id: string; prompt: string | null; asked_at: string | Date }>(
    await tx.execute(sql`
      SELECT q.id, q.steps -> -1 ->> 'prompt' AS prompt, q.created_at AS asked_at
        FROM agent_questions q
       WHERE q.project_id = ${row.projectId}
         AND q.status = 'open'
         AND q.blocker_kind IN ('human', 'master_or_peer')
         AND q.batch_id IS NULL
         AND (q.requirement_id = ${row.id}
              OR (q.about ->> 'kind' = 'requirement' AND q.about ->> 'requirementId' = ${row.id}::text))
      UNION ALL
      SELECT c.id, split_part(c.body, E'\n', 1) AS prompt, c.created_at AS asked_at
        FROM comments c
        JOIN steward_acts a
          ON a.wrote ->> 'kind' = 'comment' AND a.wrote ->> 'ref' = c.id::text AND a.undone_at IS NULL
       WHERE c.requirement_id = ${row.id}
         AND c.intent = 'question'
         AND NOT EXISTS (
           SELECT 1 FROM comments reply WHERE reply.parent_id = c.id AND reply.author_id <> c.author_id)
       ORDER BY asked_at, id`),
  );
  const notBlocking = await notBlockingOf(tx, row);
  return rows
    .filter((r) => !notBlocking.has(r.id))
    .map((r) => ({
      id: r.id,
      prompt: r.prompt ?? '',
      askedAt: new Date(r.asked_at).toISOString(),
    }));
}

/**
 * The questions its revisions list as not blocking, by each question's newest entry: asked, never
 * required (its reason, REQ-34 BC-17), so the delivery waits on them no more than the agree did.
 */
async function notBlockingOf(tx: Tx, row: CheckedRow): Promise<Set<string>> {
  const entries = rowsOf<{ id: string; blocking: boolean | null }>(
    await tx.execute(sql`
      SELECT DISTINCT ON (e ->> 'questionId') e ->> 'questionId' AS id, (e ->> 'blocking')::boolean AS blocking
        FROM requirement_revisions rv
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(rv.spec -> 'openQuestions', '[]'::jsonb)) e
       WHERE rv.requirement_id = ${row.id} AND e ->> 'questionId' IS NOT NULL
       ORDER BY e ->> 'questionId', rv.revision DESC`),
  );
  return new Set(entries.filter((e) => e.blocking === false).map((e) => e.id));
}

async function workflowGaps(tx: Tx, row: CheckedRow): Promise<DeliveryGap[]> {
  const linked = rowsOf<{ flow: string; title: string | null; traced: boolean }>(
    await tx.execute(sql`
      SELECT w.flow, w.document ->> 'title' AS title,
             EXISTS (
               SELECT 1 FROM requirement_criterion_steps s
                 JOIN requirement_criteria c
                   ON c.requirement_id = s.requirement_id AND c.code = s.code
                  AND c.retired_revision IS NULL
                WHERE s.requirement_id = rw.requirement_id AND s.workflow_id = w.id) AS traced
        FROM requirement_workflows rw
        JOIN project_workflows w ON w.id = rw.workflow_id
       WHERE rw.requirement_id = ${row.id}
       ORDER BY w.flow`),
  );
  if (linked.length === 0) {
    const [drawn] = rowsOf<{ n: number }>(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM project_workflows WHERE project_id = ${row.projectId}`,
      ),
    );
    if (!drawn?.n) return [];
    return [
      {
        kind: 'no_workflow',
        ref: null,
        title: null,
        detail:
          'it names no workflow it changes; link the workflow it changes, so its picture shows the steps it touches.',
      },
    ];
  }
  return linked
    .filter((w) => !w.traced)
    .map((w) => ({
      kind: 'untraced_workflow' as const,
      ref: w.flow,
      title: w.title ?? w.flow,
      detail: `no criterion traces a step of the workflow ${w.title ?? w.flow}, so its picture lights none; trace the steps each criterion changes.`,
    }));
}

interface LinkRow {
  relation: 'conflict' | 'duplicate';
  key: string;
  title: string | null;
  basis: string | null;
  status: string | null;
  quoted_live: boolean;
  decided: boolean;
}

async function linkGaps(tx: Tx, row: CheckedRow): Promise<DeliveryGap[]> {
  const links = rowsOf<LinkRow>(
    await tx.execute(sql`
      SELECT l ->> 'relation' AS relation,
             upper(l -> 'ref' ->> 'key') AS key,
             l -> 'ref' ->> 'title' AS title,
             l ->> 'basis' AS basis,
             r.status,
             EXISTS (
               SELECT 1 FROM requirement_criteria c
                WHERE c.requirement_id = r.id AND c.retired_revision IS NULL
                  AND c.body = l ->> 'basis') AS quoted_live,
             EXISTS (
               SELECT 1 FROM comments d
                WHERE d.requirement_id = ${row.id} AND d.intent = 'decision'
                  AND d.created_at > dr.drafted_at
                  AND d.body ~* ('\\m' || (l -> 'ref' ->> 'key') || '\\M')) AS decided
        FROM intake_drafts dr
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(dr.body -> 'links', '[]'::jsonb)) l
        LEFT JOIN requirements r
          ON r.project_id = dr.project_id
         AND 'REQ-' || r.req_seq = upper(l -> 'ref' ->> 'key')
       WHERE dr.requirement_id = ${row.id}
         AND dr.outcome = 'drafted'
         AND l ->> 'relation' IN ('conflict', 'duplicate')
         AND l -> 'ref' ->> 'kind' = 'requirement'`),
  );
  const own = requirementKey(row.reqSeq);
  return links
    .filter(
      (l) =>
        l.key !== own &&
        l.status !== null &&
        liveStatus(l.status) &&
        !l.decided &&
        (l.relation === 'duplicate' || l.quoted_live),
    )
    .map((l) => ({
      kind: l.relation,
      ref: l.key,
      title: l.title,
      detail:
        l.relation === 'conflict'
          ? `it contradicts ${l.key} on "${l.basis ?? ''}"; record which holds as a decision on ${own}, or revise one of them.`
          : `it repeats ${l.key}; record whether both are built as a decision on ${own}, or merge or drop one of them.`,
    }));
}

/** When the steward last finished checking it since its head was agreed; null where it has not. */
async function checkedAt(tx: Tx, row: CheckedRow): Promise<string | null> {
  const [hit] = rowsOf<{ at: string | Date | null }>(
    await tx.execute(sql`
      SELECT max(sr.ended_at) AS at
        FROM steward_runs sr
        JOIN requirement_revisions rv
          ON rv.requirement_id = sr.subject_id AND rv.revision = ${row.currentRevision}
       WHERE sr.subject_kind = 'requirement'
         AND sr.subject_id = ${row.id}
         AND sr.state = 'done'
         AND sr.acts_to_run && ARRAY['intake_check', 'breakdown_check']::text[]
         AND sr.ended_at >= coalesce(rv.decided_at, rv.created_at)`),
  );
  return hit?.at ? new Date(hit.at).toISOString() : null;
}

/** The delivery check of an agreed requirement, read inside `tx`; `owed` says whether the steward is on. */
export async function deliveryCheckIn(
  tx: Tx,
  row: CheckedRow,
  owed: boolean,
): Promise<RequirementDeliveryCheck> {
  const questions = await openQuestions(tx, row);
  const workflows = await workflowGaps(tx, row);
  const links = await linkGaps(tx, row);
  const checked = owed && row.currentRevision !== null ? await checkedAt(tx, row) : null;
  const gaps = [...workflows, ...links];
  return {
    owed,
    checkedAt: checked,
    questions,
    gaps,
    clear: questions.length === 0 && (!owed || checked !== null),
  };
}

/**
 * Every refusal the check holds the move into delivery with, at once; empty where it holds none. A
 * gap is never one (owner rulings 2026-10-31, 2026-11-01): it goes back as a question on the
 * requirement, which the steward's check asks and the master answers, so the move waits on the
 * question and on the check, never on a canned list.
 */
export function deliveryCheckRefusals(check: RequirementDeliveryCheck): RequirementRefusal[] {
  return [
    ...check.questions.map((q) => ({
      code: 'REQUIREMENT_QUESTION_OPEN' as const,
      path: `/questions/${q.id}`,
      detail: `delivery waits on the answer to: ${q.prompt}`,
    })),
    ...(check.owed && check.checkedAt === null
      ? [
          {
            code: 'REQUIREMENT_UNCHECKED' as const,
            path: '',
            detail:
              'the steward has not finished a check of it since its head was agreed; it is checked within 5 minutes of its agree and of each breakdown proposed for it.',
          },
        ]
      : []),
  ];
}
